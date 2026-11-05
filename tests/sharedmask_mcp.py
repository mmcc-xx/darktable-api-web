#!/usr/bin/env python3
"""MCP side of tests/sharedmask.mjs (W65): with the scratch engine's env
(DTAPI_SOCKET...), a stdio darktable-api-mcp server on the same engine as the
web app; prints one JSON line.

  setup PHOTO        denoiseprofile and color balance rgb on; prints {"ok"}
  masks PHOTO OP     list_masks of OP (instance 0): {"ok", "shapes": [...]}
  param PHOTO OP     set_blending OP with a g_in range: {"ok"}
  modules PHOTO      {"ok", "modules": [[operation, instance, enabled], ...]}
"""
import asyncio
import json
import os
import sys
from pathlib import Path

MCP = Path.home() / "darktable-api-mcp/.venv/bin/darktable-api-mcp"


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
            await call("enable_module", operation="denoiseprofile", enabled=True)
            await call("enable_module", operation="colorbalancergb", enabled=True)
            return {"ok": True}
        if cmd == "masks":
            return {"ok": True, "shapes": js(await call("list_masks", operation=rest[0])).get("shapes", [])}
        if cmd == "param":
            await call("set_blending", operation=rest[0], values={"parametric": {"g_in": {"range": [0, 0, 60, 80]}}})
            return {"ok": True}
        if cmd == "modules":
            mods = js(await call("list_modules"))
            mods = mods.get("modules", mods) if isinstance(mods, dict) else mods
            return {"ok": True, "modules": [[m["operation"], m["instance"], m.get("enabled")] for m in mods]}
        return {"ok": False, "error": f"no command {cmd}"}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main(*sys.argv[1:]))))
