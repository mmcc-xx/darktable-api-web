#!/usr/bin/env python3
"""MCP side of tests/parammask.mjs (W63): with the scratch engine's env
(DTAPI_SOCKET...), a stdio darktable-api-mcp server on the same engine as the
web app; prints one JSON line.

  setup PHOTO       exposure lift (+0.9 EV) using a new named mask "background"
                    (parametric Cz_in inverted with boost 6.64, g_in); prints
                    {"ok", "lift", "mask"}
"""
import asyncio
import json
import os
import sys
from pathlib import Path

MCP = Path.home() / "darktable-api-mcp/.venv/bin/darktable-api-mcp"
BACKGROUND = {"parametric": {"Cz_in": {"range": [15, 20, 30, 35], "inverted": True, "boost": 6.64},
                             "g_in": {"range": [0, 0, 40, 60]}}}


async def main(cmd, photo, *rest):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    params = StdioServerParameters(command=str(MCP), args=[], env=dict(os.environ))
    async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
        await s.initialize()

        async def call(tool, **kw):
            res = await s.call_tool(tool, kw)
            if res.isError:
                raise SystemExit(json.dumps({"ok": False, "tool": tool, "error": res.content[0].text[:300]}))
            return res

        def js(res):
            return json.loads(res.content[0].text)

        await call("open_photo", image_id=int(photo))
        if cmd == "setup":
            ei = js(await call("add_module_instance", operation="exposure"))["instance"]
            await call("set_module", operation="exposure", instance=ei, values={"exposure": 0.9})
            r = js(await call("set_blending", operation="exposure", instance=ei, named="background", values=BACKGROUND))
            mods = js(await call("list_modules"))
            mods = mods.get("modules", mods) if isinstance(mods, dict) else mods
            hold = next((m["instance"] for m in mods if m["operation"] == "exposure" and m.get("name") == "background"), None)
            if hold is None:
                hold = (r.get("mask") or {}).get("instance")
            return {"ok": hold is not None, "lift": ei, "mask": hold}
        return {"ok": False, "error": f"no command {cmd}"}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main(*sys.argv[1:]))))
