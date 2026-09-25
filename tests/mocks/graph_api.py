#!/usr/bin/env python3
"""Mock of the WhatsApp Cloud API (Graph API) for tests.

* POST /<version>/<phone_number_id>/messages  -> validates the payload against
  Meta's field limits (HTTP 400 on violation, like the real API), records it,
  returns {"messages": [{"id": "wamid.mock.N"}]}
* GET  /__captured   -> JSON list of every accepted/rejected request
* POST /__reset      -> clear captures

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
        if not p["template"].get("name"):
            errs.append("template name")
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
        self._send(404, {"error": "not found"})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/__reset":
            with LOCK:
                CAPTURED.clear()
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
        self._send(200, {"messaging_product": "whatsapp", "contacts": [{"wa_id": payload.get("to")}],
                         "messages": [{"id": f"wamid.mock.{n}"}]})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8081)
    args = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
