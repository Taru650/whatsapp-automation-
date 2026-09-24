#!/usr/bin/env python3
"""Mock of the Anthropic Messages API for tests (no real key, no cost).

Returns a structured-output classification chosen by keywords in the user
message:
  contains "echo"    -> {"service_key": "echo", "subtype": "repeat", confidence 0.93}
  contains "unsure"  -> {"service_key": "echo", ..., confidence 0.3}  (below threshold)
  contains "fail500" -> HTTP 500
  otherwise          -> {"service_key": "none"}
GET /__captured lists received requests; POST /__reset clears them.
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
CAPTURED = []
EMPTY_SLOTS = {"place": "", "category": "", "date": "", "block": "", "department": ""}


def classify(text):
    t = text.lower()
    if "echo" in t:
        return {"service_key": "echo", "subtype": "repeat", "slots": EMPTY_SLOTS, "lang": "en", "confidence": 0.93}
    if "unsure" in t:
        return {"service_key": "echo", "subtype": "repeat", "slots": EMPTY_SLOTS, "lang": "en", "confidence": 0.3}
    return {"service_key": "none", "subtype": "", "slots": EMPTY_SLOTS, "lang": "en", "confidence": 0.9}


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
        req = json.loads(raw)
        with LOCK:
            CAPTURED.append({"headers": {"x-api-key": bool(self.headers.get("x-api-key")),
                                         "anthropic-version": self.headers.get("anthropic-version")},
                             "body": req})
        text = req["messages"][-1]["content"]
        if "fail500" in text:
            return self._send(500, {"type": "error", "error": {"type": "api_error", "message": "mock failure"}})
        if req.get("output_config", {}).get("format", {}).get("type") != "json_schema":
            return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "expected json_schema"}})
        out = classify(text)
        self._send(200, {
            "id": "msg_mock", "type": "message", "role": "assistant", "model": req.get("model"),
            "content": [{"type": "text", "text": json.dumps(out)}],
            "stop_reason": "end_turn", "usage": {"input_tokens": 420, "output_tokens": 38},
        })


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8082)
    args = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
