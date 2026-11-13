#!/usr/bin/env python3
"""Mock of Google's OAuth token endpoint + Sheets API values:batchGet, for tests.

* POST /token                                       -> {"access_token": "mock-token", ...}
  (checks it received a JWT-bearer assertion with three parts)
* GET  /v4/spreadsheets/<id>?fields=sheets.properties.title -> the tab names
* GET  /v4/spreadsheets/<id>/values:batchGet?ranges=..  -> tabs set via /__set
  (401 without the bearer token; 400 if a requested tab does not exist, like Google)
* POST /__set   {"tabs": {...}}   replace the sheet content
* POST /__fail  {"status": 500}   make the next batchGet fail (0 = stop failing)
"""
import argparse
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {"tabs": {}, "fail": 0, "calls": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/token":
            form = urllib.parse.parse_qs(raw.decode())
            ok = form.get("grant_type") == ["urn:ietf:params:oauth:grant-type:jwt-bearer"] and \
                len((form.get("assertion") or [""])[0].split(".")) == 3
            return self._send(200 if ok else 400, {"access_token": "mock-token", "expires_in": 3600, "token_type": "Bearer"}
                              if ok else {"error": "invalid_grant"})
        body = json.loads(raw or b"{}")
        with LOCK:
            if self.path == "/__set":
                STATE["tabs"] = body.get("tabs", {})
                return self._send(200, {"ok": True})
            if self.path == "/__fail":
                STATE["fail"] = int(body.get("status", 500))
                return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/__calls":
            return self._send(200, {"calls": STATE["calls"]})
        parts = url.path.split("/")
        is_meta = len(parts) == 4 and parts[1] == "v4" and parts[2] == "spreadsheets"
        if not (url.path.endswith("/values:batchGet") or is_meta):
            return self._send(404, {"error": "not found"})
        if self.headers.get("Authorization") != "Bearer mock-token":
            return self._send(401, {"error": {"code": 401, "message": "Request had invalid authentication credentials."}})
        if is_meta:
            with LOCK:
                if STATE["fail"]:
                    return self._send(STATE["fail"], {"error": {"code": STATE["fail"], "message": "backend error"}})
                return self._send(200, {"sheets": [{"properties": {"title": t}} for t in STATE["tabs"]]})
        with LOCK:
            STATE["calls"] += 1
            if STATE["fail"]:
                return self._send(STATE["fail"], {"error": {"code": STATE["fail"], "message": "backend error"}})
            raw = urllib.parse.parse_qs(url.query).get("ranges", [])
            # like Google: 'Tab name' (quoted, '' = one quote) or a bare name
            ranges = [r[1:-1].replace("''", "'") if len(r) > 1 and r[0] == r[-1] == "'" else r for r in raw]
            missing = [r for r in ranges if r not in STATE["tabs"]]
            if missing:
                return self._send(400, {"error": {"code": 400, "message": f"Unable to parse range: {missing[0]}"}})
            quote = lambda t: "'" + t.replace("'", "''") + "'" if not t.isalnum() else t
            out = [{"range": f"{quote(r)}!A1:Z1000", "majorDimension": "ROWS", "values": STATE["tabs"][r]} for r in ranges]
        self._send(200, {"spreadsheetId": url.path.split("/")[3], "valueRanges": out})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8083)
    ThreadingHTTPServer(("127.0.0.1", ap.parse_args().port), Handler).serve_forever()
