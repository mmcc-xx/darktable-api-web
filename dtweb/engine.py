"""
engine.py — the web app's client for the darktable-api engine.

It is darktable-api-mcp's client (darktable_api_mcp/engine.py: connecting,
starting the engine, busy retries, error codes, render lanes, the library
lock; its docstring lists the configuration), with what only the web app
needs: emit() and its own client name. DTAPI_CONFIGDIR defaults to
library-copy/config here.

darktable-api-mcp is imported if it is installed in this Python, else from
its checkout: the one DTAPI_MCP runs from, else ~/darktable-api-mcp.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("DTAPI_CONFIGDIR", os.path.abspath("library-copy/config"))


def _mcp_checkout() -> Path | None:
    if os.environ.get("DTAPI_MCP"):        # <checkout>/.venv/bin/darktable-api-mcp
        root = Path(os.environ["DTAPI_MCP"]).resolve().parents[2]
        if (root / "darktable_api_mcp" / "engine.py").exists():
            return root
    root = Path.home() / "darktable-api-mcp"
    return root if (root / "darktable_api_mcp" / "engine.py").exists() else None


try:
    import darktable_api_mcp.engine as _mcp_engine
except ImportError:
    if not (_root := _mcp_checkout()):
        raise ImportError("darktable-api-mcp not found: install it in this Python, "
                          "or set DTAPI_MCP to its program in its checkout's .venv") from None
    sys.path.append(str(_root))
    import darktable_api_mcp.engine as _mcp_engine

BIN, CONFIG, SOCKET = _mcp_engine.BIN, _mcp_engine.CONFIG, _mcp_engine.SOCKET
EngineError = _mcp_engine.EngineError


class Engine(_mcp_engine.Engine):
    client_kind = "web"
    client_name = "darktable-api-web"

    def emit(self, ev: dict) -> None:
        """Pass an event to the listeners as if the engine had sent it: the
        engine doesn't echo a client's own changes, and all the browser tabs
        share this one connection."""
        for fn in list(self._listeners):
            try:
                fn(ev)
            except Exception:
                pass


engine = Engine()
