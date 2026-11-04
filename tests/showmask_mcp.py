#!/usr/bin/env python3
"""MCP side of tests/showmask.mjs (W62): with the scratch engine's env
(DTAPI_SOCKET...), a stdio darktable-api-mcp server on the same engine as the
web app; prints one JSON line.

  setup PHOTO       exposure instance at +0.9 EV with a parametric chroma mask
                    (inverted) and color balance rgb with a drawn circle
  change PHOTO OP INST   moves the exposure instance to +1.2 EV (another client's change)
  compare PHOTO URL OP INST   the web app's preview with that mask (URL/api/photo/PHOTO/
                    preview.jpg?w=600&h=600&mask_op=..) against MCP render_preview(show_mask=..):
                    mean difference, and the yellow fraction of both
"""
import asyncio
import json
import os
import sys
import urllib.request
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
            ei = js(await call("add_module_instance", operation="exposure"))["instance"]
            await call("set_module", operation="exposure", instance=ei, values={"exposure": 0.9})
            await call("set_blending", operation="exposure", instance=ei,
                       values={"parametric": {"Cz_in": {"range": [15, 20, 30, 35], "inverted": True}}})
            await call("add_mask", operation="colorbalancergb", shape="circle", x=0.4, y=0.5, radius=0.2)
            return {"ok": True, "exposure": ei}
        if cmd == "change":
            op, inst = rest[0], int(rest[1])
            await call("set_module", operation=op, instance=inst, values={"exposure": 1.2})
            return {"ok": True}
        if cmd == "compare":
            import cv2
            import numpy as np
            url, op, inst = rest[0], rest[1], int(rest[2])
            q = f"{url}/api/photo/{photo}/preview.jpg?w=600&h=600&mask_op={op}&mask_instance={inst}"
            with urllib.request.urlopen(q, timeout=120) as f:
                web = cv2.imdecode(np.frombuffer(f.read(), np.uint8), cv2.IMREAD_COLOR).astype(np.float32)
                note = f.headers.get("X-Mask")
            res = await call("render_preview", size=600, show_mask=op, show_mask_instance=inst)
            img = next(c for c in res.content if c.type == "image")
            import base64
            mcp = cv2.imdecode(np.frombuffer(base64.b64decode(img.data), np.uint8), cv2.IMREAD_COLOR).astype(np.float32)
            if mcp.shape != web.shape:
                mcp = cv2.resize(mcp, (web.shape[1], web.shape[0]), interpolation=cv2.INTER_AREA)

            def yellow(a):        # BGR: red and green high, blue well below
                b, g, r = a[..., 0], a[..., 1], a[..., 2]
                return float(((r > 120) & (g > 100) & (b < 0.6 * g)).mean())
            return {"ok": True, "diff": round(float(np.abs(web - mcp).mean()), 2), "x_mask": note,
                    "yellow_web": round(yellow(web), 3), "yellow_mcp": round(yellow(mcp), 3)}
        return {"ok": False, "error": f"no command {cmd}"}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main(*sys.argv[1:]))))
