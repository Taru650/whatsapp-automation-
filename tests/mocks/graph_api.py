#!/usr/bin/env python3
"""Mock of the WhatsApp Cloud API (Graph API) for tests.

* POST /<version>/<phone_number_id>/messages  -> validates the payload against
  Meta's field limits (HTTP 400 on violation, like the real API), records it,
  returns {"messages": [{"id": "wamid.mock.N"}]}
* GET  /<version>/<media-id>  -> media metadata {"url", "mime_type", "file_size"}
  for the fixed set of test media ids below (svc-complaint's evidence download)
* GET  /__media/<media-id>    -> the (fake) bytes for that media id
* GET  /__captured   -> JSON list of every accepted/rejected request
* POST /__reset      -> clear captures (and any /__fail_to recipients)
* POST /__fail_to    -> {"to": "<number>"}: every later send to that number gets
  HTTP 400 (Meta's "message undeliverable", code 131026) until /__reset

Stdlib only. Usage: python tests/mocks/graph_api.py --port 8081
"""
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
CAPTURED = []
COUNTER = [0]
FAIL_TO = set()

# Fixed test media ids for svc-complaint's evidence download (n8n/src/core/media.js).
MEDIA_FIXTURES = {
    "MEDIA_IMAGE_1": {"mime_type": "image/jpeg", "file_size": 2048, "bytes": b"\xff\xd8\xff" + b"fake-jpeg-bytes"},
    "MEDIA_IMAGE_2": {"mime_type": "image/jpeg", "file_size": 2048, "bytes": b"\xff\xd8\xff" + b"fake-jpeg-bytes-2"},
    "MEDIA_PDF_1": {"mime_type": "application/pdf", "file_size": 2048, "bytes": b"%PDF-1.4 fake-pdf-bytes"},
    "MEDIA_TOOBIG_1": {"mime_type": "image/jpeg", "file_size": 11 * 1024 * 1024, "bytes": b""},
    "MEDIA_BADTYPE_1": {"mime_type": "video/mp4", "file_size": 1024, "bytes": b"fake-video-bytes"},
}


def length(s):
    return len(s or "")


def validate(p):
    errs = []
    if p.get("messaging_product") != "whatsapp":
        errs.append("messaging_product")
    if not p.get("to"):
        errs.append("to missing")
    t = p.get("type")
    if t == "text":
        if not 0 < length(p["text"].get("body")) <= 4096:
            errs.append("text.body length")
    elif t == "interactive":
        i = p["interactive"]
        body = (i.get("body") or {}).get("text")
        if i["type"] != "location_request_message" and not 0 < length(body) <= 1024:
            errs.append("interactive.body length")
        if i["type"] == "button":
            buttons = i["action"]["buttons"]
            if not 1 <= len(buttons) <= 3:
                errs.append("button count")
            ids = [b["reply"]["id"] for b in buttons]
            if len(set(ids)) != len(ids):
                errs.append("duplicate button ids")
            for b in buttons:
                if not 0 < length(b["reply"]["title"]) <= 20:
                    errs.append(f"button title length: {b['reply']['title']!r}")
        elif i["type"] == "list":
            a = i["action"]
            if not 0 < length(a.get("button")) <= 20:
                errs.append("list button length")
            rows = [r for s in a["sections"] for r in s["rows"]]
            if not 1 <= len(rows) <= 10:
                errs.append("row count")
            for s in a["sections"]:
                if length(s.get("title")) > 24:
                    errs.append("section title length")
            for r in rows:
                if not 0 < length(r["title"]) <= 24:
                    errs.append(f"row title length: {r['title']!r}")
                if length(r.get("description")) > 72:
                    errs.append("row description length")
        elif i["type"] == "location_request_message":
            if (i.get("action") or {}).get("name") != "send_location":
                errs.append("location_request action")
        else:
            errs.append(f"unknown interactive type {i['type']}")
    elif t == "location":
        loc = p["location"]
        if not isinstance(loc.get("latitude"), (int, float)) or not isinstance(loc.get("longitude"), (int, float)):
            errs.append("location lat/lon")
    elif t == "template":
        tpl = p["template"]
        if not tpl.get("name"):
            errs.append("template name")
        if not (tpl.get("language") or {}).get("code"):
            errs.append("template language")
        for c in tpl.get("components") or []:
            for prm in c.get("parameters") or []:
                v = prm.get("text") if prm.get("type") == "text" else "x"
                # Meta (error 132018): variables may not be empty or hold newlines,
                # tabs or more than four consecutive spaces
                if not v or "\n" in v or "\t" in v or "     " in v:
                    errs.append(f"template parameter: {v!r}")
    else:
        errs.append(f"unknown type {t}")
    return errs


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/__captured":
            with LOCK:
                return self._send(200, CAPTURED)
        if self.path.startswith("/__media/"):
            meta = MEDIA_FIXTURES.get(self.path[len("/__media/"):])
            if not meta:
                return self._send(404, {"error": "not found"})
            body = meta["bytes"]
            self.send_response(200)
            self.send_header("Content-Type", meta["mime_type"])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        # GET /<version>/<media-id>: Graph's media metadata lookup (one path segment, not .../messages)
        parts = self.path.strip("/").split("/")
        if len(parts) == 2 and parts[0].startswith("v"):
            meta = MEDIA_FIXTURES.get(parts[1])
            if not meta:
                return self._send(404, {"error": {"message": "media not found", "type": "GraphMethodException", "code": 100}})
            port = self.server.server_address[1]
            return self._send(200, {"url": f"http://127.0.0.1:{port}/__media/{parts[1]}",
                                     "mime_type": meta["mime_type"], "file_size": meta["file_size"], "id": parts[1]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/__reset":
            with LOCK:
                CAPTURED.clear()
                FAIL_TO.clear()
            return self._send(200, {"ok": True})
        if self.path == "/__fail_to":
            with LOCK:
                FAIL_TO.add(json.loads(raw)["to"])
            return self._send(200, {"ok": True})
        if not self.path.endswith("/messages"):
            return self._send(404, {"error": "not found"})
        try:
            payload = json.loads(raw)
            errs = validate(payload)
        except Exception as e:  # malformed payload
            payload, errs = {"raw": raw.decode(errors="replace")}, [f"bad json: {e}"]
        auth_ok = (self.headers.get("Authorization") or "").startswith("Bearer ")
        with LOCK:
            COUNTER[0] += 1
            n = COUNTER[0]
            CAPTURED.append({"n": n, "ts": time.time(), "path": self.path, "payload": payload, "errors": errs, "auth": auth_ok})
        if errs:
            return self._send(400, {"error": {"message": "; ".join(errs), "type": "OAuthException", "code": 100}})
        with LOCK:
            fail = payload.get("to") in FAIL_TO
        if fail:
            return self._send(400, {"error": {"message": "Message undeliverable", "type": "OAuthException", "code": 131026}})
        self._send(200, {"messaging_product": "whatsapp", "contacts": [{"wa_id": payload.get("to")}],
                         "messages": [{"id": f"wamid.mock.{n}"}]})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8081)
    args = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
