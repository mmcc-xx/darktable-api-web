"""
mcp_worker.py: runs darktable-api-mcp's own functions for the web app (dust
detection and healing, object removal with ai_fill), under the MCP's Python
(it has numpy, opencv and rawpy, the web app's doesn't) as
    python -I mcp_worker.py '{"op": "find", "image_id": 12}'
It calls the MCP server's functions, on the same engine as the web app
(DTAPI_BIN, DTAPI_CONFIGDIR, DTAPI_SOCKET), so it joins the photo's open
edit, unsaved changes included, and the page sees its edits as events.
Prints one JSON line: the result, or {"error": "..."}.

ops: find {rebuild_map}, heal {spots: [ids]},
     heal_at {x, y, radius}: a heal circle where the user clicked (x, y
     fractions of the photo as shown, radius a fraction of its shorter side)
     with a source this worker picks from a 100% render around it.
     fill_models {}: the fill models (local and online, whether the online
     ones have a key); image_id is ignored.
     fill {shape: "circle"|"path", x, y, radius | points, model, prompt,
     context}: ai_fill on the photo's open edit; returns its reply.
     clip {path, iso, mask_size}: sensor clipping and blocked shadows of a
     raw file, from the file alone (no engine): {shares, png_b64}; image_id
     is ignored. clip_batch {items: [{id, path, iso}]}: {id: shares | null}
     (null when rawpy can't read the file: JPEG, TIFF...).
     pano_check {ids, match_edits_from}: the panorama prerequisites report
     (the MCP's make_panorama without fixes); image_id is ignored.
     pano_make {ids, fixes, projection, crop, in_order}: stitch with Hugin;
     progress lines go to stderr as "PROGRESS <message>". The folder is
     DTWEB_PANORAMA_DIR, else beside the first frame.
"""

import asyncio
import base64
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


async def fill_models(server, n: int, req: dict) -> list:
    from darktable_api_mcp import bfl
    try:
        bfl.api_key()
        have = True
    except bfl.BflError:
        have = False
    return ([{"id": "local", "label": "LaMa (on this machine)", "online": False}]
            + [{"id": k, "label": v[1], "online": True, "available": have} for k, v in bfl.MODELS.items()])


async def fill(server, n: int, req: dict) -> dict:
    from mcp.server.fastmcp.exceptions import ToolError
    await server.engine.open(n)
    args = dict(shape=req["shape"], feather=0.005, context=float(req.get("context", 0.5)),
                model=req.get("model", "local"), prompt=req.get("prompt", ""), name="erase")
    if req["shape"] == "path":
        args["points"] = req["points"]
    else:
        args.update(x=float(req["x"]), y=float(req["y"]), radius=float(req["radius"]))
    try:
        return _parse(await server.ai_fill(**args))
    except ToolError as exc:
        return {"error": str(exc)}


async def pano_check(server, n: int, req: dict) -> dict:
    from darktable_api_mcp import panorama
    try:
        await server._require("export.bpp", "image_duplicate", "history_paste")
        return await panorama.check(server.engine, [int(i) for i in req["ids"]], req.get("match_edits_from"))
    except (panorama.PanoramaError, server.ToolError, server.EngineError) as exc:
        return {"error": str(exc)}


async def pano_make(server, n: int, req: dict) -> dict:
    from darktable_api_mcp import panorama

    def say(msg: str) -> None:
        print(f"PROGRESS {msg}", file=sys.stderr, flush=True)

    try:
        await server._require("export.bpp", "image_duplicate", "history_paste")
        return await panorama.stitch(
            server.engine, [int(i) for i in req["ids"]], fixes=req.get("fixes") or {},
            projection=req.get("projection") or "auto", crop=bool(req.get("crop", True)),
            in_order=bool(req.get("in_order")), folder=os.environ.get("DTWEB_PANORAMA_DIR") or None, log=say)
    except (panorama.PanoramaError, server.ToolError, server.EngineError) as exc:
        return {"error": str(exc)}


def clip(req: dict) -> dict:
    from darktable_api_mcp import clipping
    r = clipping.measure(req["path"], req.get("iso"), int(req.get("mask_size") or 0) or None)
    return {"shares": r["shares"], "png_b64": base64.b64encode(r["png"]).decode() if r["png"] else None}


def clip_batch(req: dict) -> dict:
    from darktable_api_mcp import clipping
    out = {}
    for it in req["items"]:
        try:
            out[str(it["id"])] = clipping.measure(it["path"], it.get("iso"))["shares"]
        except Exception:       # not a raw rawpy reads
            out[str(it["id"])] = None
    return out


async def main(req: dict) -> dict:
    if req.get("op") == "clip":
        return clip(req)
    if req.get("op") == "clip_batch":
        return clip_batch(req)
    from darktable_api_mcp import server
    n = int(req["image_id"])
    op = {"find": find, "heal": heal, "heal_at": heal_at, "fill_models": fill_models,
          "fill": fill, "pano_check": pano_check, "pano_make": pano_make}.get(req.get("op"))
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
