"""Launcher for the ORENEX backend JSON API.

Usage::

    python run.py
    python run.py --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import argparse

from orenex.api import serve


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="orenex-backend",
        description="ORENEX simulation engine — JSON HTTP API (standard library only).",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port (default 8000)")
    args = parser.parse_args()
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
