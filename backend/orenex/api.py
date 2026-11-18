"""Minimal JSON HTTP API over the ORENEX engine — standard library only.

Uses :class:`http.server.ThreadingHTTPServer` with a tiny hand-rolled router, so
there is nothing to install. Every response is JSON produced by
:func:`orenex.engine.to_jsonable`, which makes the engine's typed arrays,
callables and non-finite floats safe to serialise.

Run it with ``python run.py`` (see the repo README).
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import engine


class _NotFound(Exception):
    """Raised when no route matches the request path."""


def _int(query: dict, key: str, default: int) -> int:
    try:
        return int(query.get(key, [str(default)])[0])
    except (TypeError, ValueError):
        return default


def route(method: str, path: str, query: dict, body: dict | None):
    """Resolve a request to a JSON-ready result (raises ``_NotFound``)."""
    if method == "GET":
        if path in ("/", "/index"):
            return {"service": "orenex-backend", "engine": engine.ENGINE_VERSION, "endpoints": engine.endpoints()}
        if path == "/health":
            return engine.health()
        if path == "/overview":
            return engine.overview()
        if path == "/geology":
            return engine.geology_layer()
        if path == "/geology/terrain":
            return engine.terrain_grid(_int(query, "step", 4))
        if path == "/prospectivity":
            return engine.prospectivity_summary()
        if path == "/prospectivity/grid":
            return engine.prospectivity_grid(_int(query, "step", 4))
        if path == "/targets":
            return engine.targets()
        if path == "/reserves":
            return engine.reserves_all()
        if path == "/operations":
            return engine.operations_summary()
        if path == "/forecast":
            return engine.forecast_mine(query.get("mine", ["MNE-BAL"])[0], _int(query, "horizon", 30))
        if path == "/alerts":
            return engine.alerts()
        if path == "/backtest":
            return engine.backtest_mine(query.get("mine", ["MNE-BAL"])[0])
        if path == "/backtest/portfolio":
            return engine.backtest_portfolio()
        if path == "/reconciliation":
            return engine.reconciliation_summary()
        if path == "/validation":
            return engine.validation_summary()
        if path == "/models":
            return engine.model_registry()
        if path == "/manganese":
            return engine.manganese()
        if path == "/manganese/model":
            return engine.manganese_model()
        if path == "/assistant/suggestions":
            return engine.assistant_suggestions()
    elif method == "POST":
        if path == "/assistant":
            payload = body or {}
            question = str(payload.get("q") or payload.get("question") or "").strip()
            if not question:
                raise ValueError("missing 'q' in request body")
            ctx = {k: payload[k] for k in ("targetId", "mineId", "cutOff") if k in payload}
            return engine.assistant_ask(question, ctx or None)
    raise _NotFound(path)


class Handler(BaseHTTPRequestHandler):
    server_version = "orenex/1.0.0"

    def _send(self, status: int, payload) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    self._send(400, {"error": "invalid JSON body"})
                    return
        try:
            result = route(method, parsed.path, query, body)
            self._send(200, engine.to_jsonable(result))
        except _NotFound:
            self._send(404, {"error": "not found", "path": parsed.path})
        except Exception as exc:  # noqa: BLE001 — surface any engine fault as a 500
            self._send(500, {"error": type(exc).__name__, "message": str(exc)})

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:  # one concise line per request
        print(f"{self.address_string()} {fmt % args}", flush=True)


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ORENEX backend listening on http://{host}:{port}", flush=True)
    print("Heavy layers build on first request (reserves/prospectivity take ~1 min).", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    serve()
