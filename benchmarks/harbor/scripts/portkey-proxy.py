#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.client
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ALLOWED_PATHS = frozenset({"/v1/messages", "/v1/messages/count_tokens", "/v1/responses"})
HOP_BY_HOP_HEADERS = {
    "accept-encoding",
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
UPSTREAM_TIMEOUT_SECONDS = 900
READ_CHUNK_BYTES = 65536


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--upstream", default="https://api.portkey.ai")
    return parser.parse_args(argv)


def open_upstream(upstream: str) -> http.client.HTTPConnection:
    parts = urlsplit(upstream)
    if parts.scheme == "https":
        return http.client.HTTPSConnection(parts.hostname, parts.port, timeout=UPSTREAM_TIMEOUT_SECONDS)
    return http.client.HTTPConnection(parts.hostname, parts.port, timeout=UPSTREAM_TIMEOUT_SECONDS)


def make_handler(upstream: str, api_key: str) -> type[BaseHTTPRequestHandler]:
    class PortkeyProxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if ".." in self.path or "%" in path or path not in ALLOWED_PATHS:
                self.send_error(404)
                return
            length = self.headers.get("Content-Length")
            if length is None:
                self.send_error(411)
                return
            body = self.rfile.read(int(length))
            headers = {name: value for name, value in self.headers.items() if name.lower() not in HOP_BY_HOP_HEADERS}
            headers["x-portkey-api-key"] = api_key
            headers["Content-Length"] = str(len(body))
            connection = open_upstream(upstream)
            try:
                connection.request("POST", self.path, body=body, headers=headers)
                response = connection.getresponse()
            except OSError as error:
                connection.close()
                sys.stderr.write(f"portkey-proxy: upstream failed with {type(error).__name__}\n")
                self.send_error(502)
                return
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in HOP_BY_HOP_HEADERS:
                    self.send_header(name, value)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while chunk := response.read1(READ_CHUNK_BYTES):
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            connection.close()

        def log_message(self, format: str, *args: object) -> None:
            return

    return PortkeyProxy


def main(argv: list[str]) -> None:
    arguments = parse_arguments(argv)
    api_key = os.environ.get("PORTKEY_API_KEY")
    if not api_key:
        sys.exit("portkey-proxy: PORTKEY_API_KEY is required")
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), make_handler(arguments.upstream, api_key))
    server.serve_forever()


if __name__ == "__main__":
    main(sys.argv[1:])
