"""The parsing worker's HTTP server, which normalization's worker parser calls
(engine/parsing/src/worker.ts). Stateless: it keeps nothing between requests.

    POST /v1/parse   body: the file's bytes, with its Content-Type and, URL-encoded,
                     x-inspiration-filename
                     200 ParseResult: blocks, parser, warnings
                     415 a type it does not read; 422 a file it cannot read (broken,
                     encrypted, or a scan without a text layer); 413 over MAX_BYTES
    GET  /v1/health  {"ok": true, "version", "types"}

Errors are {"error": {"code", "message"}}. The type comes from the Content-Type, else from
the file name's extension.

    python -m inspiration_parsing [--host 127.0.0.1] [--port 8790]

Port 0 picks a free port. The first line it prints says where it listens.
"""

import argparse
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

from . import VERSION, pdf, sheets, slides, word
from .blocks import Unreadable

PARSERS = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ("docx", ".docx", word.parse),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ("pptx", ".pptx", slides.parse),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ("xlsx", ".xlsx", sheets.parse),
    "application/pdf": ("pdf", ".pdf", pdf.parse),
}
# Above the engine's 50 MiB upload limit, so the engine's limit is the one people meet.
MAX_BYTES = 64 * 1024 * 1024


def parser_for(mime_type: str, filename: str):
    if mime_type in PARSERS:
        return PARSERS[mime_type]
    lower = filename.lower()
    return next((p for p in PARSERS.values() if lower.endswith(p[1])), None)


class Handler(BaseHTTPRequestHandler):
    server_version = "inspiration-parsing/" + VERSION
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path != "/v1/health":
            return self.fail(404, "not_found", f"no route GET {self.path}")
        self.answer(200, {"ok": True, "version": VERSION, "types": sorted(PARSERS)})

    def do_POST(self):
        if self.path != "/v1/parse":
            return self.fail(404, "not_found", f"no route POST {self.path}")
        length = int(self.headers.get("content-length") or -1)
        if length < 0:
            return self.fail(411, "bad_request", "send the file with a Content-Length")
        if length > MAX_BYTES:
            return self.fail(413, "too_large", f"a file has at most {MAX_BYTES} bytes")
        data = self.rfile.read(length)
        mime_type = (self.headers.get("content-type") or "").split(";")[0].strip().lower()
        filename = unquote(self.headers.get("x-inspiration-filename") or "")
        chosen = parser_for(mime_type, filename)
        if chosen is None:
            return self.fail(415, "unsupported_type", f"the worker reads Word, PowerPoint, Excel and PDF, not {mime_type}")
        name, _, parse = chosen
        try:
            blocks, warnings = parse(data)
        except Unreadable as e:
            return self.fail(422, "unreadable", str(e))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return self.fail(422, "unreadable", f"the {name} parser failed: {e}")
        result = {"blocks": blocks, "parser": {"component": "parsing", "name": name, "version": VERSION}}
        if warnings:
            result["warnings"] = warnings
        self.answer(200, result)

    def fail(self, status: int, code: str, message: str):
        self.answer(status, {"error": {"code": code, "message": message}})

    def answer(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_request(self, code="-", size="-"):
        # Only what went wrong: a busy worker would otherwise log every file.
        if not str(code).startswith("2"):
            super().log_request(code, size)

    def log_message(self, format, *args):
        sys.stderr.write(f"parsing: {format % args}\n")


def main():
    options = argparse.ArgumentParser(prog="inspiration_parsing", description=__doc__.split("\n\n")[0])
    options.add_argument("--host", default="127.0.0.1")
    options.add_argument("--port", type=int, default=8790)
    args = options.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    host, port = server.server_address[:2]
    print(f"listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


main()
