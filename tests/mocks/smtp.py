#!/usr/bin/env python3
"""Minimal SMTP sink for tests (the daily report e-mail), plus an HTTP view.

* SMTP on --port (default 8084): accepts any mail, no TLS, no auth.
* HTTP on --http-port (default 8085): GET /__mails -> [{"from", "to", "data"}]
                                      POST /__reset -> clears the list
Stdlib only (smtpd was removed in Python 3.12).
"""
import argparse
import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
MAILS = []


class SMTPHandler(socketserver.StreamRequestHandler):
    def reply(self, line):
        self.wfile.write((line + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        self.reply("220 mock-smtp ready")
        sender, rcpts = None, []
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            cmd = raw.decode("utf-8", "replace").strip()
            verb = cmd.split(" ", 1)[0].upper()
            if verb in ("EHLO", "HELO"):
                self.reply("250 mock-smtp")
            elif verb == "MAIL":
                sender, rcpts = cmd.split(":", 1)[1].strip(), []
                self.reply("250 OK")
            elif verb == "RCPT":
                rcpts.append(cmd.split(":", 1)[1].strip())
                self.reply("250 OK")
            elif verb == "DATA":
                self.reply("354 end with <CRLF>.<CRLF>")
                lines = []
                while True:
                    l = self.rfile.readline()
                    if not l or l in (b".\r\n", b".\n"):
                        break
                    lines.append(l[1:] if l.startswith(b"..") else l)
                with LOCK:
                    MAILS.append({"from": sender, "to": rcpts, "data": b"".join(lines).decode("utf-8", "replace")})
                self.reply("250 queued")
            elif verb == "QUIT":
                self.reply("221 bye")
                return
            elif verb in ("RSET", "NOOP"):
                self.reply("250 OK")
            else:
                self.reply("502 not implemented")


class HTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        with LOCK:
            self._send(list(MAILS))

    def do_POST(self):
        with LOCK:
            MAILS.clear()
        self._send({"ok": True})


class SMTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8084)
    ap.add_argument("--http-port", type=int, default=8085)
    a = ap.parse_args()
    threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", a.http_port), HTTPHandler).serve_forever, daemon=True).start()
    SMTPServer(("127.0.0.1", a.port), SMTPHandler).serve_forever()
