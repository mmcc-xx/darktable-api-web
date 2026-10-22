"""
dust_worker.py: dust detection and healing for the web app, run under
darktable-api-mcp's Python (it has numpy, opencv and rawpy, the web app's
doesn't) as
    python -I dust_worker.py '{"op": "find", "image_id": 12}'
It calls the MCP server's own functions, on the same engine as the web app
(DTAPI_BIN, DTAPI_CONFIGDIR, DTAPI_SOCKET), so it joins the photo's open
edit, unsaved changes included, and the page sees its edits as events.
Prints one JSON line: the result, or {"error": "..."}.

ops: find {rebuild_map}, heal {spots: [ids]},
     heal_at {x, y, radius}: a heal circle where the user clicked (x, y
     fractions of the photo as shown, radius a fraction of its shorter side)
     with a source this worker picks from a 100% render around it.
"""

import asyncio
import json
import math
import os
import sys


def _parse(r) -> dict:
    return json.loads(r[0]) if isinstance(r, (list, tuple)) else r


async def find(server, n: int, req: dict) -> dict:
    s = _parse(await server.find_dust_spots(image_id=n, rebuild_map=bool(req.get("rebuild_map"))))
    spots = [p for p in s["spots"] if p.get("on_photo")]
    if spots:
        # each spot's size as a fraction of the photo's width: map a point one
        # radius to the right of its center in the raw to the photo as shown
        w = (await server.engine.call("image_info", imgid=n))["image"]["width"]
        pts = []
        for p in spots:
            pts += [[p["raw_x"], p["raw_y"]], [p["raw_x"] + p["diameter_px"] / 2 / w, p["raw_y"]]]
        out = (await server.engine.edit(n, "coords", points=pts, **{"from": "raw", "to": "image"}))["points"]
        for i, p in enumerate(spots):
            (u0, v0), (u1, v1) = out[2 * i], out[2 * i + 1]
            p["r_photo"] = max(0.004, round(math.hypot(u1 - u0, v1 - v0), 5))
    return s


async def heal(server, n: int, req: dict) -> dict:
    return _parse(await server.heal_dust_spots(image_id=n, spots=[int(i) for i in req["spots"]]))


async def heal_at(server, n: int, req: dict) -> dict:
    import cv2
    import numpy as np
    x, y, radius = float(req["x"]), float(req["y"]), float(req["radius"])
    dust = server._dust_module()
    await server.engine.open(n)
    # a 100% render around the click, to choose a smooth patch to copy from
    r = await server.engine.render(n, 480, 480, False, {"zoom": 1.0, "center_x": x, "center_y": y})
    if r is None:
        raise RuntimeError("the render was overtaken by another request")
    data, info = r
    R = info["region"]
    im = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR).astype(np.float32) / 255.0
    lum = im @ np.array([0.0722, 0.7152, 0.2126], np.float32)    # BGR
    h, w = lum.shape
    kx, ky = R["right"] - R["left"], R["bottom"] - R["top"]
    full_w, full_h = w / kx, h / ky
    R_px = radius * min(full_w, full_h)
    px, py = (x - R["left"]) / kx * w, (y - R["top"]) / ky * h
    src = dust.choose_source(lum, px, py, R_px, [], min_dist=2.2 * R_px)
    if src:
        sx, sy = src["x"], src["y"]
    else:
        # nothing smooth enough: 3 radii to whichever side stays inside the crop
        sx = px + 3 * R_px if px + 3 * R_px + R_px < w else px - 3 * R_px
        sy = py
    sx, sy = R["left"] + sx / w * kx, R["top"] + sy / h * ky
    sx, sy = min(1.0, max(0.0, sx)), min(1.0, max(0.0, sy))
    res = await server.retouch_spots([{"x": x, "y": y, "radius": radius, "tool": "heal",
                                       "source_x": round(sx, 5), "source_y": round(sy, 5)}])
    return {**res, "source": [round(sx, 5), round(sy, 5)]}


async def main(req: dict) -> dict:
    from darktable_api_mcp import server
    n = int(req["image_id"])
    op = {"find": find, "heal": heal, "heal_at": heal_at}.get(req.get("op"))
    if not op:
        raise RuntimeError(f"unknown op {req.get('op')!r}")
    return await op(server, n, req)


if __name__ == "__main__":
    code = 0
    try:
        out = asyncio.run(main(json.loads(sys.argv[1])))
    except BaseException as exc:    # ToolError and the like carry the message
        out, code = {"error": str(exc) or type(exc).__name__}, 1
    print(json.dumps(out))
    sys.stdout.flush()
    # the MCP's engine client keeps the process alive otherwise
    os._exit(code)
