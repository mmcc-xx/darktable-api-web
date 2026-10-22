"""
darktable-api-web: browse a darktable library and edit photos through the
darktable-api engine.

Run from the repository root:
    DTAPI_BIN=/path/to/darktable-api uvicorn dtweb.main:app --port 8020

No authentication: keep it on 127.0.0.1 or a trusted network.
"""

from __future__ import annotations

from pathlib import Path

import asyncio
import base64
import json
import math
import os
import secrets
import shlex
import shutil
import tempfile
import time
import urllib.parse
import zipfile

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .engine import BIN, CONFIG, SOCKET, EngineError, engine

HERE = Path(__file__).parent
app = FastAPI(title="darktable-api-web")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")
# the stylesheet's address changes with the file, so browsers don't keep an old one
templates.env.globals["static_version"] = lambda name: int((HERE / "static" / name).stat().st_mtime)


def _mcp_program() -> str | None:
    """The darktable-api-mcp program (DTAPI_MCP, else on the PATH, else the
    checkout in the home folder)."""
    mcp = os.environ.get("DTAPI_MCP") or shutil.which("darktable-api-mcp")
    if not mcp and (Path.home() / "darktable-api-mcp/.venv/bin/darktable-api-mcp").exists():
        mcp = str(Path.home() / "darktable-api-mcp/.venv/bin/darktable-api-mcp")
    return mcp


def _connect() -> dict:
    """The Connect Claude dialog's commands: the MCP server on this web app's
    engine and library (DTAPI_MCP: the darktable-api-mcp program)."""
    mcp = _mcp_program()
    env = [("DTAPI_BIN", BIN), ("DTAPI_CONFIGDIR", CONFIG)]
    if os.environ.get("DTAPI_SOCKET"):
        env.append(("DTAPI_SOCKET", os.environ["DTAPI_SOCKET"]))
    q = lambda v: shlex.quote(str(v))
    command = " \\\n  ".join(["claude mcp add darktable-api", *(f"-e {k}={q(v)}" for k, v in env),
                               f"-- {q(mcp or '/path/to/darktable-api-mcp/.venv/bin/darktable-api-mcp')}"])
    skills = Path(mcp).resolve().parents[2] / "skills" if mcp else None
    return {"command": command, "found": bool(mcp),
            "skills": (f"mkdir -p ~/.claude/skills\nfor s in {q(skills)}/*/; do ln -s \"$s\" ~/.claude/skills/; done"
                       if skills and skills.is_dir() else None)}


templates.env.globals["connect"] = _connect()

PAGE = 60
THUMB_SIZE = 400
THUMBS = CONFIG.parent / "web-thumbs"       # thumbnails by image, size and edit state
RATINGS = ["visible", "all", "rejected", "1", "2", "3", "4", "5"]
LABELS = ["red", "yellow", "green", "blue", "purple"]

# the editing panels: field, label, slider range (any value inside the
# module's declared range can still be typed), display factor, unit, digits
PANELS = [
    ("exposure", "exposure", [
        ("exposure", "exposure", -3.0, 4.0, 1, "EV", 2),
        ("black", "black level", -0.1, 0.1, 1, "", 4),
    ]),
    ("agx", "AgX", [
        ("curve_contrast_around_pivot", "contrast", 0.5, 6.0, 1, "", 2),
        ("look_saturation", "saturation", 0.0, 2.0, 100, "%", 0),
        ("look_brightness", "brightness", 0.5, 2.0, 1, "", 2),
    ]),
    ("sigmoid", "sigmoid", [
        ("middle_grey_contrast", "contrast", 0.5, 3.0, 1, "", 2),
        ("contrast_skewness", "skew", -1.0, 1.0, 1, "", 2),
    ]),
    # darktable's nine bands, by the scene exposure each one is centred on
    ("toneequal", "tone equalizer", [
        (name, f"{ev} EV {label}", -2.0, 2.0, 1, "EV", 2)
        for name, ev, label in [
            ("noise", "−8", "blacks"), ("ultra_deep_blacks", "−7", "deep shadows"),
            ("deep_blacks", "−6", "shadows"), ("blacks", "−5", "light shadows"),
            ("shadows", "−4", "midtones"), ("midtones", "−3", "dark highlights"),
            ("highlights", "−2", "highlights"), ("whites", "−1", "whites"), ("speculars", "0", "speculars")]
    ]),
    ("colorbalancergb", "color balance rgb", [
        ("vibrance", "global vibrance", -1.0, 1.0, 100, "%", 0),
        ("contrast", "contrast", -1.0, 1.0, 100, "%", 0),
        ("chroma_global", "global chroma", -1.0, 1.0, 100, "%", 0),
        ("saturation_global", "global saturation", -1.0, 1.0, 100, "%", 0),
    ]),
]


def _filters(request: Request) -> dict:
    q = request.query_params
    roll = q.get("roll", "")
    label = q.get("label", "")
    return {"roll": int(roll) if roll.isdigit() else None,
            "rating": q.get("rating") if q.get("rating") in RATINGS else "visible",
            "label": int(label) if label.isdigit() and int(label) < len(LABELS) else None,
            "tag": q.get("tag", "").strip() or None}


def _query(f: dict) -> str:
    return urllib.parse.urlencode({k: v for k, v in f.items() if v is not None})


def _list_args(f: dict) -> dict:
    a = {"film_id": f["roll"] if f["roll"] is not None else -1, "rating": f["rating"],
         "label": f["label"] if f["label"] is not None else -1}
    if f["tag"]:
        a["tag"] = f["tag"]     # an engine without images_list.tag ignores it; the page then hides the field
    return a


def _version(img: dict) -> str:
    """Changes whenever the photo's rendering may: part of thumbnail URLs."""
    return f"{img['changed']}-{img['history_end']}"


async def _library_state() -> dict:
    ok, why = engine.available()
    if not ok:
        return {"state": "unavailable", "detail": why}
    try:
        return await engine.library("library_status")
    except EngineError as exc:
        return {"state": "error", "detail": str(exc)}


# ── library ──────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def library_page(request: Request):
    f = _filters(request)
    ctx = {"filters": f, "query": _query(f), "ratings": RATINGS, "labels": LABELS,
           "lib": await _library_state(), "rolls": [], "images": [], "total": 0, "next_offset": None,
           "error": None, "tag_filter": False, "import_dir": _import_dir()}
    if ctx["lib"].get("state") == "owned":
        try:
            ctx["tag_filter"] = await engine.supports("images_list.tag")
            ctx["rolls"] = (await engine.call("film_rolls"))["film_rolls"]
            r = await engine.call("images_list", offset=0, limit=PAGE, **_list_args(f))
            ctx.update(images=r["images"], total=r["total"],
                       next_offset=PAGE if PAGE < r["total"] else None)
        except EngineError as exc:
            ctx["error"] = str(exc)
    return templates.TemplateResponse(request, "library.html", {**ctx, "version": _version})


@app.get("/grid", response_class=HTMLResponse)
async def grid(request: Request, offset: int = 0):
    f = _filters(request)
    try:
        r = await engine.call("images_list", offset=offset, limit=PAGE, **_list_args(f))
    except EngineError as exc:
        raise HTTPException(409, str(exc))
    return templates.TemplateResponse(request, "_tiles.html", {
        "images": r["images"], "query": _query(f), "labels": LABELS, "version": _version,
        "next_offset": offset + PAGE if offset + PAGE < r["total"] else None})


@app.get("/thumb/{image_id}/{version}.jpg")
async def thumbnail(image_id: int, version: str, size: int = THUMB_SIZE):
    size = max(64, min(size, 2048))
    path = THUMBS / f"{image_id}_{size}_{version.replace('/', '_')}.jpg"
    if not path.exists():
        try:
            data = await engine.thumbnail(image_id, size)
        except EngineError as exc:
            raise HTTPException(404, str(exc))
        THUMBS.mkdir(parents=True, exist_ok=True)
        for old in THUMBS.glob(f"{image_id}_{size}_*.jpg"):
            old.unlink(missing_ok=True)
        path.write_bytes(data)
    # the version is in the URL, so a cached copy never goes stale
    return Response(path.read_bytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


class RatingBody(BaseModel):
    rating: int | str


class LabelBody(BaseModel):
    label: int
    on: bool


@app.post("/api/photo/{image_id}/rating", response_class=HTMLResponse)
async def set_rating(request: Request, image_id: int, body: RatingBody):
    try:
        r = await engine.call("set_rating", imgid=image_id, rating=body.rating)
    except EngineError as exc:
        raise HTTPException(400, str(exc))
    return _tile(request, r["image"])


@app.post("/api/photo/{image_id}/label", response_class=HTMLResponse)
async def set_label(request: Request, image_id: int, body: LabelBody):
    try:
        r = await engine.call("set_label", imgid=image_id, label=body.label, on=body.on)
    except EngineError as exc:
        raise HTTPException(400, str(exc))
    return _tile(request, r["image"])


class DuplicateBody(BaseModel):
    virgin: bool = False
    save: bool = False


# a duplicate (virtual copy) as the lighttable's: with the saved edit, or
# unedited (virgin); unsaved changes are refused unless save
@app.post("/api/photo/{image_id}/duplicate")
async def duplicate(image_id: int, body: DuplicateBody):
    try:
        return await engine.call("image_duplicate", imgid=image_id, virgin=body.virgin, save=body.save)
    except EngineError as exc:
        raise _bad(exc)


@app.get("/api/photo/{image_id}/details")
async def photo_details(image_id: int):
    """The lighttable's detail panel: the image, its exif lines, title,
    description and tags (darktable's own tags left out)."""
    try:
        info = await engine.call("image_info", imgid=image_id)
        meta = await engine.call("image_metadata", imgid=image_id)
    except EngineError as exc:
        raise HTTPException(404, str(exc))
    m = meta.get("metadata") or {}
    return {"image": info["image"], "version": _version(info["image"]), "shot": _shot(info.get("exif")),
            "title": m.get("title", ""), "description": m.get("description", ""),
            "tags": _user_tags(meta.get("tags"))}


def _user_tags(tags: list) -> list[str]:
    names = [t if isinstance(t, str) else t.get("name", "") for t in tags or []]
    return [n for n in names if n and not n.startswith("darktable|")]


@app.get("/api/tags")
async def tags(filter: str = ""):
    """The library's tags (darktable's own left out) with how many photos
    carry each: suggestions for the tag fields and the tag filter."""
    try:
        r = await engine.call("tag_list", filter=filter)
    except EngineError as exc:
        raise _bad(exc)
    return {"tags": [{"name": t["name"], "images": t.get("images", 0)} for t in r.get("tags") or []
                     if not t["name"].startswith("darktable|")]}


class TagsBody(BaseModel):
    imgids: list[int]
    attach: list[str] = []
    detach: list[str] = []


@app.post("/api/tags")
async def set_tags(body: TagsBody):
    """Attach and detach tags by name (| for the hierarchy), as darktable's
    tagging module; new tags are created."""
    attach = [t.strip() for t in body.attach if t.strip()]
    detach = [t.strip() for t in body.detach if t.strip()]
    if not body.imgids or not (attach or detach):
        raise HTTPException(400, "no photos or no tags")
    try:
        await engine.call("set_tags", imgids=body.imgids, attach=attach, detach=detach)
    except EngineError as exc:
        raise _bad(exc)
    return {"ok": True}


class MetadataBody(BaseModel):
    title: str | None = None
    description: str | None = None


@app.post("/api/photo/{image_id}/metadata")
async def set_metadata(image_id: int, body: MetadataBody):
    """Title and description, as darktable's metadata editor ("" clears)."""
    values = {k: v.strip() for k, v in body.model_dump().items() if v is not None}
    if not values:
        raise HTTPException(400, "nothing to set")
    try:
        await engine.call("set_metadata", imgids=[image_id], values=values)
    except EngineError as exc:
        raise _bad(exc)
    return await photo_details(image_id)


def _tile(request: Request, img: dict):
    f = _filters(request)
    return templates.TemplateResponse(request, "_tile.html", {
        "img": img, "query": _query(f), "labels": LABELS, "version": _version})


# ── photo page ───────────────────────────────────────────────────────────────

async def _collection(f: dict) -> list[dict]:
    """Every image of the filtered list (pages of 1000)."""
    images, offset, total = [], 0, 1
    while offset < total:
        r = await engine.call("images_list", offset=offset, limit=1000, **_list_args(f))
        total = r["total"]
        images += r["images"]
        offset += 1000
    return images


async def _neighbours(image_id: int, f: dict) -> tuple[int | None, int | None, int, int]:
    """Previous and next image in the filtered list, position and total."""
    ids = [i["id"] for i in await _collection(f)]
    if image_id not in ids:
        return None, None, 0, len(ids)
    k = ids.index(image_id)
    return (ids[k - 1] if k else None), (ids[k + 1] if k + 1 < len(ids) else None), k + 1, len(ids)


# the filtered list in short, for the full screen view
@app.get("/api/collection")
async def collection(request: Request):
    try:
        images = await _collection(_filters(request))
    except EngineError as exc:
        raise _bad(exc, 409)
    return {"images": [
        {"id": i["id"], "version": _version(i), "rating": "reject" if i.get("rejected") else i.get("rating", 0),
         "name": i["filename"] + (f" ({i['version']})" if i.get("version") else ""),
         **{k: i[k] for k in ("width", "height") if i.get(k)}} for i in images]}


def _shot(e: dict | None) -> list[str]:
    """Camera, lens and exposure lines for the panel head, from image_info's exif."""
    e = e or {}
    maker, model = (e.get("maker") or "").strip(), (e.get("model") or "").strip()
    camera = model if model.lower().startswith(maker.lower().split()[0] if maker else "") else f"{maker} {model}".strip()
    taken = e.get("taken") or ""
    if taken:
        taken = taken[:10].replace(":", "-") + taken[10:16]
    t, parts = e.get("exposure_time") or 0, []
    if t:
        parts.append(f"1/{round(1 / t)} s" if t < 0.4 else f"{t:g} s")
    if e.get("aperture"):
        parts.append(f"f/{e['aperture']:.1f}".replace(".0", ""))
    if e.get("iso"):
        parts.append(f"ISO {e['iso']:.0f}")
    if e.get("focal_length"):
        parts.append(f"{e['focal_length']:.0f} mm")
    if e.get("exposure_bias"):
        parts.append(f"{e['exposure_bias']:+.1f} EV")
    lines = [" · ".join(x for x in (camera, taken) if x), (e.get("lens") or "").strip(), " · ".join(parts)]
    return [x for x in lines if x]


@app.get("/photo/{image_id}", response_class=HTMLResponse)
async def photo_page(request: Request, image_id: int):
    f = _filters(request)
    lib = await _library_state()
    ctx = {"image_id": image_id, "img": None, "query": _query(f), "lib": lib,
           "prev": None, "next": None, "pos": 0, "total": 0, "error": None, "labels": LABELS, "shot": [],
           "can_fill": False, "can_mask": False}
    if lib.get("state") == "owned":
        try:
            ctx["can_fill"] = await engine.supports("ai_fill")
            ctx["can_mask"] = await engine.supports("mask_ai")
            info = await engine.call("image_info", imgid=image_id)
            ctx["img"], ctx["shot"] = info["image"], _shot(info.get("exif"))
            ctx["prev"], ctx["next"], ctx["pos"], ctx["total"] = await _neighbours(image_id, f)
        except EngineError as exc:
            ctx["error"] = str(exc)
    return templates.TemplateResponse(request, "photo.html", ctx)


# darktable's plumbing (raw decoding, color profiles, orientation) and what
# the crop tool covers: left out of the "other modules" list
PLUMBING = {"rawprepare", "temperature", "highlights", "demosaic", "demosaicscale", "colorin", "colorout",
            "gamma", "finalscale", "overexposed", "rawoverexposed", "flip", "crop", "clipping", "ashift"}


def _others(mods: list[dict], mono: dict | None) -> list[dict]:
    """Modules in the edit's history that no panel shows (often added by an
    AI or a preset): label, instance, on/off."""
    shown = {(op, 0) for op, _, _ in PANELS} | {("channelmixerrgb", 0), ("rgblevels", 0)}
    if mono:
        shown.add(("channelmixerrgb", mono["instance"]))
    shown |= _area_names(mods)
    return [{"operation": m["operation"], "instance": m["instance"], "label": m["label"], "enabled": m["enabled"]}
            for m in mods if m.get("in_history") and m["operation"] not in PLUMBING
            and (m["operation"], m["instance"]) not in shown]


async def _state(image_id: int) -> dict:
    mods = (await engine.edit(image_id, "module_list"))["modules"]
    listed = {m["operation"] for m in mods}
    modules = []
    for op, title, fields in PANELS:
        if op == "sigmoid" and op not in listed:
            continue                       # sigmoid only for photos edited with it
        try:
            g = await engine.edit(image_id, "module_get", operation=op)
        except EngineError as exc:
            modules.append({"operation": op, "title": title, "missing": str(exc), "fields": []})
            continue
        by_name = {x["name"]: x for x in g["fields"]}
        out = []
        for name, label, lo, hi, factor, unit, digits in fields:
            x = by_name.get(name)
            if x is None:
                continue
            out.append({"name": name, "label": label, "value": x["value"], "default": x["default"],
                        "lo": max(lo, x.get("min", lo)), "hi": min(hi, x.get("max", hi)),
                        "factor": factor, "unit": unit, "digits": digits})
        modules.append({"operation": op, "title": title, "enabled": g["enabled"], "fields": out})
    try:
        geometry = await engine.edit(image_id, "geometry_get")
    except EngineError as exc:
        # a darktable built before crop & rotate: the rest still works
        geometry = {"missing": str(exc)}
    mono = await _mono(image_id)
    return {"modules": modules, "history": await engine.edit(image_id, "history_list"),
            "geometry": geometry, "mono": mono, "others": _others(mods, mono),
            "wb": await _wb(image_id), "levels": await _levels(image_id)}


# ── white balance: color calibration's illuminant (its first instance) as a
# temperature and a tint, the distance from the Planckian locus (CIE 1960
# uv, × 1000; + is light greener than a black body, so the photo goes
# magenta). Set as a custom illuminant; its picker sets one from an area
def _locus(t: float) -> tuple[float, float]:
    """The Planckian locus in uv (Krystek 1985)."""
    u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t)
    v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t)
    return u, v


def _normal(t: float) -> tuple[float, float]:
    """The locus's unit normal at t, toward green (+v)."""
    (u0, v0), (u1, v1) = _locus(t * 0.999), _locus(t * 1.001)
    n = math.hypot(u1 - u0, v1 - v0)
    nu, nv = (v0 - v1) / n, (u1 - u0) / n
    return (nu, nv) if nv > 0 else (-nu, -nv)


def wb_to_xy(temperature: float, tint: float) -> tuple[float, float]:
    u, v = _locus(temperature)
    nu, nv = _normal(temperature)
    u, v = u + tint / 1000 * nu, v + tint / 1000 * nv
    d = 2 * u - 8 * v + 4
    return 3 * u / d, 2 * v / d


def xy_to_wb(x: float, y: float) -> tuple[float, float]:
    """Temperature (the locus's closest point) and tint of a chromaticity."""
    d = -2 * x + 12 * y + 3
    u, v = 4 * x / d, 6 * y / d
    dist = lambda lt: math.dist((u, v), _locus(math.exp(lt)))
    a, b, g = math.log(1000), math.log(40000), (math.sqrt(5) - 1) / 2
    for _ in range(60):                    # golden section on log T
        c, e = b - g * (b - a), a + g * (b - a)
        a, b = (a, e) if dist(c) < dist(e) else (c, b)
    t = math.exp((a + b) / 2)
    (lu, lv), (nu, nv) = _locus(t), _normal(t)
    return t, ((u - lu) * nu + (v - lv) * nv) * 1000


async def _wb(image_id: int) -> dict:
    try:
        g = await engine.edit(image_id, "module_get", operation="channelmixerrgb", instance=0)
    except EngineError as exc:
        return {"missing": str(exc)}
    f = {x["name"]: x for x in g["fields"]}
    t, tint = xy_to_wb(f["x"]["value"], f["y"]["value"])
    ill = f["illuminant"]
    label = next((v["label"] for v in ill.get("values", []) if v["name"] == ill["value"]), ill["value"])
    return {"enabled": g["enabled"], "temperature": t, "tint": tint, "illuminant": label,
            # adaptation "none (bypass)": the white balance module does it, and the picker is hidden
            "bypass": f["adaptation"]["value"] == "DT_ADAPTATION_RGB"}


class WbBody(BaseModel):
    temperature: float
    tint: float


@app.post("/api/photo/{image_id}/wb")
async def photo_wb(image_id: int, body: WbBody):
    x, y = wb_to_xy(max(1667.0, min(body.temperature, 25000.0)), max(-60.0, min(body.tint, 60.0)))
    try:
        r = await engine.edit(image_id, "module_set", operation="channelmixerrgb", instance=0,
                              values={"illuminant": "DT_ILLUMINANT_CUSTOM", "x": x, "y": y})
        return {**r, "history": await engine.edit(image_id, "history_list"), "wb": await _wb(image_id)}
    except EngineError as exc:
        raise _bad(exc)


# ── rgb levels: black, gray and white of its first channel, the one
# "RGB, linked channels" applies to all three; values of its input (before
# the tone mapper), 0..1
async def _levels(image_id: int) -> dict:
    try:
        g = await engine.edit(image_id, "module_get", operation="rgblevels")
    except EngineError as exc:
        return {"missing": str(exc)}
    f = {x["name"]: x for x in g["fields"]}
    return {"enabled": g["enabled"], "levels": f["levels"]["value"], "default": f["levels"]["default"][0],
            "linked": f["autoscale"]["value"] == "DT_IOP_RGBLEVELS_LINKED_CHANNELS"}


class PickBody(BaseModel):
    operation: str
    instance: int = 0
    control: str
    box: dict


@app.post("/api/photo/{image_id}/pick")
async def photo_pick(image_id: int, body: PickBody):
    """A module's color picker on an area of the photo as rendered
    (fractions), as darktable's picker; one history step."""
    try:
        r = await engine.edit(image_id, "picker_apply", operation=body.operation, instance=body.instance,
                              control=body.control, box=body.box)
        if r.get("state") not in (None, "done"):
            raise HTTPException(502, r.get("error") or f"the picker job {r.get('state')}")
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc)


# ── black & white: a second color calibration instance with a gray mix, as
# darktable's monochrome presets make (the first keeps the white balance).
# The looks: darktable's film presets, and color filters as gray mixes on
# top of its luminance-based preset (darktable has no filter presets)
MONO_BASE = "_builtin_monochrome | luminance-based"
MONO_LOOKS = [
    # key, label, preset, gray mix (R, G, B) set after it
    ("luminance", "luminance", MONO_BASE, None),
    ("red", "red filter", MONO_BASE, [0.80, 0.20, 0.00]),
    ("orange", "orange filter", MONO_BASE, [0.60, 0.35, 0.05]),
    ("yellow", "yellow filter", MONO_BASE, [0.45, 0.45, 0.10]),
    ("green", "green filter", MONO_BASE, [0.20, 0.65, 0.15]),
    ("blue", "blue filter", MONO_BASE, [0.15, 0.25, 0.60]),
    ("acros", "Fuji Acros 100", "_builtin_monochrome | Fuji Acros 100", None),
    ("delta100", "Ilford Delta 100", "_builtin_monochrome | ILFORD DELTA 100", None),
    ("delta400", "Ilford Delta 400–3200", "_builtin_monochrome | ILFORD DELTA 400 - 3200", None),
    ("fp4", "Ilford FP4+", "_builtin_monochrome | ILFORD FP4+", None),
    ("hp5", "Ilford HP5+", "_builtin_monochrome | ILFORD HP5+", None),
]


async def _mono(image_id: int) -> dict | None:
    """The B&W instance (the last color calibration instance after the first
    with a gray mix): instance, enabled, gray mix; None if there is none."""
    mods = (await engine.edit(image_id, "module_list"))["modules"]
    for m in reversed([m for m in mods if m["operation"] == "channelmixerrgb" and m["instance"] > 0]):
        g = await engine.edit(image_id, "module_get", operation="channelmixerrgb", instance=m["instance"])
        grey = next((x["value"] for x in g["fields"] if x["name"] == "grey"), None)
        if grey and any(abs(v) > 1e-6 for v in grey[:3]):
            mono = {"instance": m["instance"], "enabled": g["enabled"], "grey": grey[:3]}
            return {**mono, "look": _current_look(mono)}
    return None


def _look_steps(key: str, instance: int) -> list[dict]:
    look = next((x for x in MONO_LOOKS if x[0] == key), None)
    if look is None:
        raise HTTPException(404, f"no B&W look '{key}'")
    steps = [{"method": "preset_apply", "params": {"operation": "channelmixerrgb", "instance": instance,
                                                    "name": look[2]}}]
    if look[3]:
        steps.append({"method": "module_set", "params": {"operation": "channelmixerrgb", "instance": instance,
                                                         "values": {"grey": [*look[3], 0.0]}}})
    return steps


class MonoBody(BaseModel):
    on: bool


@app.post("/api/photo/{image_id}/mono")
async def photo_mono(image_id: int, body: MonoBody):
    """Black & white on: turn the B&W instance back on, or add one (a new
    color calibration instance, not a copy) with the luminance look. Off:
    turn it off, keeping its gray mix."""
    try:
        m = await _mono(image_id)
        if m:
            if m["enabled"] != body.on:
                await engine.edit(image_id, "module_enable", operation="channelmixerrgb",
                                  instance=m["instance"], enabled=body.on)
        elif body.on:
            n = (await engine.edit(image_id, "module_add", operation="channelmixerrgb", instance=0))["instance"]
            for st in _look_steps("luminance", n):
                await engine.edit(image_id, st["method"], **st["params"])
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc)


@app.get("/api/photo/{image_id}/mono_looks")
async def photo_mono_looks(image_id: int, size: int = 200):
    """Each B&W look applied to the current edit, rendered small (as data
    URLs); the edit is unchanged."""
    size = max(64, min(size, 600))
    try:
        m = await _mono(image_id)
        if not m:
            raise HTTPException(409, "black & white is off")
        with tempfile.TemporaryDirectory(prefix="dtweb_mono_") as tmp:
            variants = [{"label": key, "path": str(Path(tmp) / f"{key}.jpg"), "steps": _look_steps(key, m["instance"])}
                        for key, *_ in MONO_LOOKS]
            r = await engine.edit(image_id, "render_variants", width=size, height=size, variants=variants)
            out = []
            for (key, label, preset, grey), v, var in zip(MONO_LOOKS, r["variants"], variants):
                data = None if v.get("error") else base64.b64encode(Path(var["path"]).read_bytes()).decode()
                out.append({"key": key, "label": label, "error": v.get("error"),
                             "src": data and "data:image/jpeg;base64," + data})
    except EngineError as exc:
        raise _bad(exc, 502)
    return {"looks": out}


def _current_look(m: dict) -> str | None:
    """The look whose gray mix the B&W instance has (film presets: their mix
    as darktable's source sets it)."""
    films = {"acros": [0.333, 0.313, 0.353], "delta100": [0.2455, 0.2537, 0.5008],
             "delta400": [0.2438, 0.2361, 0.5201], "fp4": [0.2415, 0.2215, 0.5370],
             "hp5": [0.2530, 0.2596, 0.4874], "luminance": [0.0, 1.0, 0.0]}
    for key, _, _, grey in MONO_LOOKS:
        want = grey or films.get(key)
        if want and all(abs(a - b) < 2e-3 for a, b in zip(m["grey"], want)):
            return key
    return None


class LookBody(BaseModel):
    key: str


@app.post("/api/photo/{image_id}/mono_look")
async def photo_mono_look(image_id: int, body: LookBody):
    try:
        m = await _mono(image_id)
        if not m:
            raise HTTPException(409, "black & white is off")
        for st in _look_steps(body.key, m["instance"]):
            await engine.edit(image_id, st["method"], **st["params"])
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc)


def _bad(exc: EngineError, code: int = 400) -> HTTPException:
    return HTTPException(code, str(exc))


@app.post("/api/photo/{image_id}/open")
async def photo_open(image_id: int, fresh: bool = False):
    """Open the photo for editing. If the engine has it open already (another
    client editing it, or a draft restored after taking the library back),
    this joins that edit, unsaved changes included, unless fresh: then the
    photo is reloaded as saved, for every client."""
    try:
        r = await engine.open(image_id, fresh)
        s = await _state(image_id)
        s["unsaved"] = bool(r.get("unsaved"))
        s["joined"] = bool(r.get("joined"))
        return s
    except EngineError as exc:
        raise _bad(exc, 502)


class SetBody(BaseModel):
    operation: str
    values: dict
    instance: int = 0


@app.post("/api/photo/{image_id}/set")
async def photo_set(image_id: int, body: SetBody):
    try:
        r = await engine.edit(image_id, "module_set", operation=body.operation, instance=body.instance,
                              values=body.values)
        return {**r, "history": await engine.edit(image_id, "history_list")}
    except EngineError as exc:
        raise _bad(exc)


# ── areas: the sky or the subject on its own. darktable's AI object mask
# (mask_ai) finds the area from a click; a new exposure and a new color
# balance rgb instance, both named after it, work on that area only
AREA_LABELS = ("sky", "subject")
AREA_COLOR = [("vibrance", -1.0, 1.0), ("contrast", -1.0, 1.0), ("saturation_global", -1.0, 1.0)]
AREA_OUTLINE_POINTS = 200


def _area_label(name: str) -> str | None:
    base = (name or "").strip().lower().split(" ")[0]
    return base if base in AREA_LABELS else None


def _area_names(mods: list[dict]) -> set[tuple[str, int]]:
    """The (operation, instance) of every sky / subject instance."""
    return {(m["operation"], m["instance"]) for m in mods
            if m["operation"] in ("exposure", "colorbalancergb") and m["instance"] > 0
            and m.get("in_history") and _area_label(m.get("name"))}


def _leaf_paths(shapes: list[dict]) -> list[dict]:
    out = []
    for sh in shapes:
        if sh.get("members"):
            out += _leaf_paths(sh["members"])
        elif sh.get("type") == "path" and sh.get("active", True):
            out.append(sh)
    return out


def _stride(pts: list, n: int = AREA_OUTLINE_POINTS) -> list:
    if len(pts) <= n:
        return pts
    k = math.ceil(len(pts) / n)
    return pts[::k]


async def _outline(image_id: int, operation: str, instance: int) -> list[list[list[float]]]:
    """The shapes on a module's mask as polygons in photo fractions."""
    r = await engine.edit(image_id, "mask_list", operation=operation, instance=instance)
    polys = []
    for sh in _leaf_paths(r.get("shapes", [])):
        raw = [(p.get("corner") if isinstance(p, dict) else p) for p in sh.get("points", [])]
        raw = [p for p in raw if p and len(p) >= 2]
        if len(raw) >= 3:
            polys.append(_stride(raw))
    if not polys:
        return []
    flat = [[p[0], p[1]] for poly in polys for p in poly]
    img = (await engine.edit(image_id, "coords", points=flat, **{"from": "raw", "to": "image"}))["points"]
    out, i = [], 0
    for poly in polys:
        out.append([[round(q[0], 5), round(q[1], 5)] for q in img[i:i + len(poly)]])
        i += len(poly)
    return out


async def _area_values(image_id: int, exposure: int, color: int) -> dict:
    ge = await engine.edit(image_id, "module_get", operation="exposure", instance=exposure)
    gc = await engine.edit(image_id, "module_get", operation="colorbalancergb", instance=color)
    ex = next(x for x in ge["fields"] if x["name"] == "exposure")
    out = {"ev": {"value": ex["value"], "default": ex["default"], "lo": -2.0, "hi": 2.0},
           "enabled": bool(ge["enabled"] and gc["enabled"])}
    by = {x["name"]: x for x in gc["fields"]}
    out["color"] = [{"name": n, "value": by[n]["value"], "default": by[n]["default"], "lo": lo, "hi": hi}
                    for n, lo, hi in AREA_COLOR if n in by]
    return out


class AreaBody(BaseModel):
    label: str = "subject"
    include: list[list[float]]
    exclude: list[list[float]] = []
    replace: dict | None = None


@app.post("/api/photo/{image_id}/area")
async def photo_area(image_id: int, body: AreaBody):
    """Find the sky or the subject at the clicked points and give it an
    exposure and a color balance rgb instance of its own (or, with replace,
    find it again from more points)."""
    if body.label not in AREA_LABELS:
        raise HTTPException(400, f"label: one of {', '.join(AREA_LABELS)}")
    if not body.include:
        raise HTTPException(400, "include: at least one point on the area")
    if not await engine.supports("mask_ai"):
        raise HTTPException(501, "this engine has no AI masks (mask_ai)")
    points = ([{"x": p[0], "y": p[1], "include": True} for p in body.include]
              + [{"x": p[0], "y": p[1], "include": False} for p in body.exclude])
    t = time.monotonic()
    try:
        if body.replace:
            ex, cb = int(body.replace["exposure"]), int(body.replace["colorbalancergb"])
            for op, inst in (("exposure", ex), ("colorbalancergb", cb)):
                for sh in (await engine.edit(image_id, "mask_list", operation=op, instance=inst)).get("shapes", []):
                    await engine.edit(image_id, "mask_remove", operation=op, instance=inst, formid=sh["formid"])
            name = None
        else:
            mods = (await engine.edit(image_id, "module_list"))["modules"]
            taken = {(m.get("name") or "").strip().lower() for m in mods if m["operation"] in ("exposure", "colorbalancergb")}
            name, n = body.label, 1
            while name in taken:
                n += 1
                name = f"{body.label} {n}"
            ex = (await engine.edit(image_id, "module_add", operation="exposure", instance=0))["instance"]
            cb = (await engine.edit(image_id, "module_add", operation="colorbalancergb", instance=0))["instance"]
            await engine.edit(image_id, "module_rename", operation="exposure", instance=ex, name=name)
            await engine.edit(image_id, "module_rename", operation="colorbalancergb", instance=cb, name=name)
            g = await engine.edit(image_id, "module_get", operation="exposure", instance=ex)
            if abs(next(x["value"] for x in g["fields"] if x["name"] == "exposure")) > 1e-9:
                await engine.edit(image_id, "module_set", operation="exposure", instance=ex, values={"exposure": 0.0})
        try:
            r = await engine.edit(image_id, "mask_ai", operation="exposure", instance=ex, points=points, combine="union")
            await engine.edit(image_id, "mask_ai", operation="colorbalancergb", instance=cb, points=points, combine="union")
        except EngineError:
            if not body.replace:             # leave no half-made area behind
                for op, inst in (("exposure", ex), ("colorbalancergb", cb)):
                    try:
                        await engine.edit(image_id, "module_remove", operation=op, instance=inst)
                    except EngineError:
                        pass
            raise
        outline = await _outline(image_id, "exposure", ex)
        return {"exposure": ex, "colorbalancergb": cb, "label": name, "area": r.get("area"), "outline": outline,
                "ms": round((time.monotonic() - t) * 1000), **await _area_values(image_id, ex, cb)}
    except EngineError as exc:
        raise _bad(exc, 502)


@app.get("/api/photo/{image_id}/areas")
async def photo_areas(image_id: int):
    """The sky / subject areas in the edit: each with its outline and values."""
    try:
        mods = (await engine.edit(image_id, "module_list"))["modules"]
        ex = {m.get("name", "").strip().lower(): m for m in mods if m["operation"] == "exposure" and m["instance"] > 0
              and m.get("in_history") and _area_label(m.get("name"))}
        cb = {m.get("name", "").strip().lower(): m for m in mods if m["operation"] == "colorbalancergb"
              and m["instance"] > 0 and m.get("in_history") and _area_label(m.get("name"))}
        areas = []
        for name, e in ex.items():
            c = cb.get(name)
            if not c:
                continue
            outline = await _outline(image_id, "exposure", e["instance"])
            if not outline:
                continue                      # no AI mask on it: not an area
            areas.append({"label": e["name"], "exposure": e["instance"], "colorbalancergb": c["instance"],
                          "outline": outline, **await _area_values(image_id, e["instance"], c["instance"])})
        return {"areas": areas}
    except EngineError as exc:
        raise _bad(exc)


class AreaRemoveBody(BaseModel):
    exposure: int
    colorbalancergb: int


@app.post("/api/photo/{image_id}/area/remove")
async def photo_area_remove(image_id: int, body: AreaRemoveBody):
    try:
        await engine.edit(image_id, "module_remove", operation="exposure", instance=body.exposure)
        await engine.edit(image_id, "module_remove", operation="colorbalancergb", instance=body.colorbalancergb)
        return {"history": await engine.edit(image_id, "history_list")}
    except EngineError as exc:
        raise _bad(exc)


class GeometryBody(BaseModel):
    """Any of: rotate (90, -90, 180), flip ("horizontal", "vertical"), angle
    (degrees), autocrop, crop ({left, top, right, bottom} in 0..1 of the
    uncropped image, or null to remove it), aspect ("free", "original",
    "3:2", ...). Only the fields sent are changed."""
    model_config = {"extra": "forbid"}
    rotate: int | None = None
    flip: str | None = None
    angle: float | None = None
    autocrop: str | None = None
    crop: dict | None = None
    aspect: str | None = None


@app.post("/api/photo/{image_id}/geometry")
async def photo_geometry(image_id: int, body: GeometryBody):
    try:
        g = await engine.edit(image_id, "geometry_set", **body.model_dump(exclude_unset=True))
        return {"geometry": g, "history": await engine.edit(image_id, "history_list")}
    except EngineError as exc:
        raise _bad(exc)


class EnableBody(BaseModel):
    operation: str
    instance: int = 0
    enabled: bool


@app.post("/api/photo/{image_id}/enable")
async def photo_enable(image_id: int, body: EnableBody):
    try:
        await engine.edit(image_id, "module_enable", operation=body.operation, instance=body.instance,
                          enabled=body.enabled)
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc)


class EndBody(BaseModel):
    end: int


@app.post("/api/photo/{image_id}/history_end")
async def photo_history_end(image_id: int, body: EndBody):
    try:
        await engine.edit(image_id, "history_end", end=body.end)
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc)


@app.post("/api/photo/{image_id}/save")
async def photo_save(image_id: int):
    try:
        return await engine.edit(image_id, "save")
    except EngineError as exc:
        raise _bad(exc, 502)


@app.post("/api/photo/{image_id}/reset")
async def photo_reset(image_id: int):
    """Start over from darktable's defaults (workflow, auto-apply presets)."""
    try:
        await engine.edit(image_id, "reset")
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc, 502)



# ── dust and erase: detection, healing and fills run in darktable-api-mcp's
# Python (numpy, opencv and rawpy are its dependencies), a worker per request,
# on the same engine as this app, so it works on the open edit and the page
# sees the changes
_mcp_lock = asyncio.Lock()
DUST_TIMEOUT_S = 300


async def _mcp_worker(op: str, image_id: int, **params) -> dict:
    mcp = _mcp_program()
    py = os.environ.get("DTAPI_MCP_PYTHON") or (str(Path(mcp).parent / "python") if mcp else None)
    if not py or not Path(py).exists():
        raise HTTPException(501, "dust needs darktable-api-mcp with its dust extras "
                                 "(pip install 'darktable-api-mcp[dust]')")
    env = {**os.environ, "DTAPI_BIN": str(BIN), "DTAPI_CONFIGDIR": str(CONFIG), "DTAPI_SOCKET": str(SOCKET),
           "DTAPI_CLIENT_KIND": "web-worker"}
    req = json.dumps({"op": op, "image_id": image_id, **params})
    async with _mcp_lock:
        proc = await asyncio.create_subprocess_exec(
            py, "-I", str(HERE / "mcp_worker.py"), req, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), DUST_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(502, f"the worker took more than {DUST_TIMEOUT_S} s")
    lines = out.decode(errors="replace").strip().splitlines()
    try:
        r = json.loads(lines[-1])
    except (IndexError, ValueError):
        tail = err.decode(errors="replace").strip().splitlines()[-3:]
        raise HTTPException(502, "dust worker failed: " + (" / ".join(tail) or "no output"))
    if isinstance(r, dict) and r.get("error"):
        raise HTTPException(502, r["error"])
    return r


class DustFindBody(BaseModel):
    rebuild: bool = False


class DustHealBody(BaseModel):
    spots: list[int]


class DustHealAtBody(BaseModel):
    x: float
    y: float
    radius: float


@app.post("/api/photo/{image_id}/dust/find")
async def dust_find(image_id: int, body: DustFindBody):
    """Dust on the photo: the roll's map rated for this photo (the MCP's
    find_dust_spots), each spot with its size on the photo (r_photo)."""
    return await _mcp_worker("find", image_id, rebuild_map=body.rebuild)


@app.post("/api/photo/{image_id}/dust/heal")
async def dust_heal(image_id: int, body: DustHealBody):
    return await _mcp_worker("heal", image_id, spots=body.spots)


@app.post("/api/photo/{image_id}/dust/heal_at")
async def dust_heal_at(image_id: int, body: DustHealAtBody):
    return await _mcp_worker("heal_at", image_id, x=body.x, y=body.y, radius=body.radius)


_fill_models: list | None = None


@app.get("/api/fill/models")
async def fill_models():
    """The models ai_fill can use: local, and Black Forest Labs' online ones
    (available: an API key is set). Cached for the app's life."""
    global _fill_models
    if _fill_models is None:
        _fill_models = await _mcp_worker("fill_models", 0)
    return _fill_models


class FillBody(BaseModel):
    shape: str
    x: float | None = None
    y: float | None = None
    radius: float | None = None
    points: list[list[float]] | None = None
    model: str = "local"
    prompt: str = ""
    context: float = 0.5


@app.post("/api/photo/{image_id}/fill")
async def fill(image_id: int, body: FillBody):
    """Remove an object: ai_fill a circle (x, y, radius as a fraction of the
    shorter side) or a path (points, photo fractions)."""
    if body.model not in {m["id"] for m in await fill_models()}:
        raise HTTPException(422, f"unknown fill model {body.model!r}")
    if body.shape == "path":
        if not body.points or not 3 <= len(body.points) <= 60 or any(len(p) != 2 for p in body.points):
            raise HTTPException(422, "a path needs 3 to 60 points [x, y]")
    elif body.shape == "circle":
        if body.x is None or body.y is None or not body.radius or body.radius <= 0:
            raise HTTPException(422, "a circle needs x, y and radius")
    else:
        raise HTTPException(422, "shape must be circle or path")
    return await _mcp_worker("fill", image_id, **body.model_dump())


class ExportBody(BaseModel):
    """darktable's export of the photo's saved edit. Omitted settings come
    from darktable's export module (format, size, quality, high quality,
    output folder pattern, conflict handling). save: save unsaved changes
    first (else they are refused)."""
    model_config = {"extra": "forbid"}
    format: str | None = None
    size: int | None = None              # longest side in pixels, 0 = full size
    quality: int | None = None
    high_quality: bool | None = None
    save: bool = False


EXPORTED: dict[str, Path] = {}           # download token -> file this app exported


def _export_params(image_id: int, body: ExportBody) -> dict:
    params: dict = {"imgid": image_id, "save": body.save}
    if body.format:
        params["format"] = body.format
    if body.size is not None:
        params["max_width"] = params["max_height"] = max(0, body.size)
    if body.quality:
        params["quality"] = body.quality
    if body.high_quality is not None:
        params["high_quality"] = body.high_quality
    return params


def _offer(path: Path) -> str:
    """A download address for a file this app exported."""
    token = secrets.token_urlsafe(12)
    EXPORTED[token] = path
    return f"/api/export/{token}/{path.name}"


@app.post("/api/photo/{image_id}/export")
async def photo_export(image_id: int, body: ExportBody):
    try:
        r = await engine.call("export", **_export_params(image_id, body))
    except EngineError as exc:
        raise _bad(exc, 409 if "unsaved" in str(exc) else 400)
    if r.get("file"):
        r["download"] = _offer(Path(r["file"]))
    return r


class BatchExportBody(ExportBody):
    """Several photos with one set of settings; zip: also offer them as one
    zip file to download (else they are only in darktable's export folder)."""
    imgids: list[int]
    zip: bool = False


BATCHES: dict[str, dict] = {}            # batch export id -> its progress and results


@app.post("/api/export_batch")
async def export_batch(body: BatchExportBody):
    """Start exporting the photos, one after another; poll
    /api/export_batch/{id}. A photo with unsaved changes is left out
    (unsaved: true) unless save."""
    if not body.imgids:
        raise HTTPException(400, "no photos to export")
    job = secrets.token_urlsafe(8)
    BATCHES[job] = b = {"total": len(body.imgids), "done": 0, "results": [], "state": "running",
                        "zip": None, "folders": []}

    async def run():
        files = []
        for imgid in body.imgids:
            res: dict = {"imgid": imgid}
            try:
                r = await engine.call("export", **_export_params(imgid, body))
                if r.get("file"):
                    files.append(Path(r["file"]))
                    res.update(file=r["file"], download=_offer(Path(r["file"])))
                else:
                    res["skipped"] = True    # darktable's conflict setting kept an existing file
            except EngineError as exc:
                res.update(error=str(exc), unsaved="unsaved" in str(exc))
            b["results"].append(res)
            b["done"] += 1
        b["folders"] = sorted({str(f.parent) for f in files})
        if body.zip and files:
            b["state"] = "zipping"
            b["zip"] = await asyncio.to_thread(_zip, files)
        b["state"] = "done"

    asyncio.create_task(run())
    return {"id": job, **b}


def _zip(files: list[Path]) -> str:
    out = Path(tempfile.mkdtemp(prefix="dtweb_export_")) / f"darktable-export-{len(files)}.zip"
    names: set[str] = set()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:   # images are compressed already
        for f in files:
            name, n = f.name, 1
            while name in names:                                  # same name from two folders
                n += 1
                name = f"{f.stem}_{n}{f.suffix}"
            names.add(name)
            z.write(f, name)
    return _offer(out)


@app.get("/api/export_batch/{job}")
async def export_batch_status(job: str):
    if job not in BATCHES:
        raise HTTPException(404, "no such batch export (they are kept until the web app restarts)")
    return {"id": job, **BATCHES[job]}


@app.get("/api/export/{token}/{name}")
async def export_download(token: str, name: str):
    """A file this app exported, for the browser to save."""
    path = EXPORTED.get(token)
    if path is None or path.name != name or not path.is_file():
        raise HTTPException(404, "no such export (exports are offered for download until the web app restarts)")
    return FileResponse(path, filename=path.name)


@app.get("/api/photo/{image_id}/preview.jpg")
async def photo_preview(image_id: int, w: int = 1200, h: int = 1200, uncropped: bool = False,
                        zoom: float = 0, cx: float = 0.5, cy: float = 0.5):
    """The edit fitted inside w x h, or with zoom (1 = 100%, up to 2) the
    w x h region around cx, cy (fractions) at that scale; X-Region has the
    part of the photo it shows (fractions, smaller at the photo's edges)."""
    cap = 3200 if zoom > 0 else 2560       # a zoomed view fills a HiDPI window
    w, h = max(64, min(w, cap)), max(64, min(h, cap))
    region = {"zoom": min(zoom, 2.0), "center_x": cx, "center_y": cy} if zoom > 0 else None
    try:
        r = await engine.render(image_id, w, h, uncropped and not region, region)
    except EngineError as exc:
        raise _bad(exc, 502)
    if r is None:
        return Response(status_code=204)   # overtaken by a newer request
    data, timing = r
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "no-store",
        "X-Render-Ms": str(timing.get("process_ms", "")),
        "X-Total-Ms": str(timing.get("total_ms", "")),
        **({"X-Region": json.dumps(timing["region"])} if timing.get("region") else {})})


@app.get("/api/photo/{image_id}/before.jpg")
async def photo_before(image_id: int, step: int, w: int = 1200, h: int = 1200):
    """The photo as it was at a history step (0 = the original), for a
    before/after comparison; nothing is undone."""
    w, h = max(64, min(w, 2560)), max(64, min(h, 2560))
    try:
        r = await engine.render(image_id, w, h, region={"history_end": step}, lane="before")
    except EngineError as exc:
        raise _bad(exc, 502)
    if r is None:
        return Response(status_code=204)
    return Response(r[0], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# alternatives an AI rendered (darktable-api-mcp's propose_alternatives):
# the engine writes them here, and the event that announces them carries
# their paths and the steps that make each one
VARIANTS_DIR = Path(os.environ.get("DTAPI_VARIANTS_DIR")
                    or Path.home() / ".cache/darktable-api-mcp/variants").resolve()
VARIANT_METHODS = {"module_set", "module_enable", "preset_apply", "blend_set", "curve_set", "geometry_set"}


# the alternatives last proposed for each photo, until one is applied or
# they are dismissed: a photo page opened later still shows them
PENDING_VARIANTS: dict[int, list[dict]] = {}


def _remember_shared(ev: dict) -> None:
    if ev.get("type") != "shared" or ev.get("kind") != "variants":
        return
    data = ev.get("data") or {}
    if data.get("variants"):
        PENDING_VARIANTS[ev["imgid"]] = data["variants"]
    else:
        PENDING_VARIANTS.pop(ev.get("imgid"), None)


engine.add_listener(_remember_shared)


@app.get("/api/photo/{image_id}/alternatives")
async def photo_alternatives(image_id: int):
    return {"variants": PENDING_VARIANTS.get(image_id, [])}


@app.post("/api/photo/{image_id}/alternatives/dismiss")
async def photo_alternatives_dismiss(image_id: int):
    PENDING_VARIANTS.pop(image_id, None)
    return {"variants": []}


@app.get("/api/variant")
async def variant_image(path: str):
    p = Path(path).resolve()
    if VARIANTS_DIR not in p.parents or p.suffix != ".jpg" or not p.is_file():
        raise HTTPException(404, "no such alternative")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


class StepsBody(BaseModel):
    steps: list[dict]


@app.post("/api/photo/{image_id}/apply_steps")
async def photo_apply_steps(image_id: int, body: StepsBody):
    """Apply an alternative: its steps, each as the edit it names."""
    bad = [st.get("method") for st in body.steps if st.get("method") not in VARIANT_METHODS]
    if bad or not body.steps:
        raise HTTPException(400, f"steps must be edits of these kinds: {', '.join(sorted(VARIANT_METHODS))}")
    try:
        for st in body.steps:
            await engine.edit(image_id, st["method"], **(st.get("params") or {}))
        PENDING_VARIANTS.pop(image_id, None)
        return await _state(image_id)
    except EngineError as exc:
        raise _bad(exc)


@app.get("/tile/{image_id}", response_class=HTMLResponse)
async def tile(request: Request, image_id: int):
    try:
        r = await engine.call("image_info", imgid=image_id)
    except EngineError as exc:
        raise HTTPException(404, str(exc))
    return _tile(request, r["image"])


# ── events: what other clients (the MCP server, ...) change ──────────────────

@app.get("/api/events")
async def events(request: Request):
    """Server-sent events: the engine's notifications about changes made by
    other clients, e.g. an AI editing the photo shown in the browser."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)

    def listener(ev: dict) -> None:
        try:
            queue.put_nowait(ev)
        except asyncio.QueueFull:
            pass

    try:
        await engine.call("ping")          # connected, so events arrive
    except EngineError:
        pass
    engine.add_listener(listener)

    async def stream():
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(queue.get(), 15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            engine.remove_listener(listener)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


# ── import ───────────────────────────────────────────────────────────────────

def _rc(key: str) -> str:
    """A darktable preference from the library copy's darktablerc."""
    try:
        for line in (CONFIG / "darktablerc").read_text(errors="replace").splitlines():
            if line.startswith(key + "="):
                return line[len(key) + 1:]
    except OSError:
        pass
    return ""


def _import_dir() -> dict:
    """Where the import dialog's folder browser starts, and where copy &
    import puts photos (darktable's import settings)."""
    start = _rc("ui_last/import_last_directory")
    if not start or not Path(start).is_dir():
        start = str(Path.home() / "Pictures") if (Path.home() / "Pictures").is_dir() else str(Path.home())
    return {"start": start, "jobcode": _rc("plugins/session/jobcode"),
            "copy_to": "/".join(p for p in (_rc("session/base_directory_pattern"),
                                            _rc("session/sub_directory_pattern")) if p)}


# what darktable imports (src/common/image.c's supported extensions, the common ones):
# only for counting photos in the folder browser; the engine decides what it imports
PHOTO_EXT = {".3fr", ".arw", ".cr2", ".cr3", ".crw", ".dng", ".erf", ".exr", ".fff", ".gpr", ".heic", ".heif",
             ".hdr", ".iiq", ".j2k", ".jp2", ".jpeg", ".jpg", ".jxl", ".kdc", ".mef", ".mos", ".mrw", ".nef",
             ".nrw", ".orf", ".ori", ".pef", ".pfm", ".png", ".raf", ".raw", ".rw2", ".rwl", ".sr2", ".srf",
             ".srw", ".tif", ".tiff", ".webp", ".x3f", ".avif", ".pnm", ".qoi"}


@app.get("/api/fs")
async def fs_list(path: str = ""):
    """A folder's subfolders and how many photos are in it, for the import
    dialog's folder browser (this app has no authentication: see README)."""
    p = Path(path or _import_dir()["start"]).expanduser()
    try:
        p = p.resolve(strict=True)
        entries = sorted(p.iterdir(), key=lambda e: e.name.lower())
    except OSError as exc:
        raise HTTPException(404, f"can't read {p}: {exc.strerror or exc}")
    dirs, photos = [], 0
    for e in entries:
        if e.name.startswith("."):
            continue
        try:
            if e.is_dir():
                dirs.append(e.name)
            elif e.suffix.lower() in PHOTO_EXT:
                photos += 1
        except OSError:
            pass
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None, "dirs": dirs, "photos": photos}


UPLOADS = CONFIG.parent / "web-uploads"      # files sent from the browser, until they are imported
IMPORTS: dict[str, dict] = {}                 # engine job id -> {"upload": folder to delete afterwards}


@app.post("/api/import/upload/{batch}")
async def import_upload(request: Request, batch: str, name: str, mtime: float = 0):
    """One file from the browser (the body is the file), into a folder per
    batch; /api/import with the batch then copies and imports them. mtime
    (seconds) keeps the file's modification time, which darktable's
    duplicate check compares."""
    if not batch.isalnum() or len(batch) > 40:
        raise HTTPException(400, "bad batch id")
    safe = Path(name).name
    if not safe or safe.startswith("."):
        raise HTTPException(400, "bad file name")
    folder = UPLOADS / batch
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / safe
    with open(dest, "wb") as f:
        async for chunk in request.stream():
            f.write(chunk)
    if mtime > 0:
        os.utime(dest, (time.time(), mtime))
    return {"file": safe, "bytes": dest.stat().st_size}


class ImportBody(BaseModel):
    """paths: files or folders on this computer; upload: a batch sent with
    /api/import/upload (always copied, as it lives in a temporary folder);
    copy_files: copy & import."""
    paths: list[str] = []
    upload: str | None = None
    recursive: bool = False
    copy_files: bool = False
    jobcode: str | None = None


@app.post("/api/import")
async def import_start(body: ImportBody):
    """darktable's import as a background job: add the photos where they
    are, or (copy) copy them into darktable's import folders first. Photos
    already in the library are skipped. Poll /api/import/{job}."""
    paths, upload = [p for p in body.paths if p.strip()], None
    if body.upload:
        if not body.upload.isalnum() or not (UPLOADS / body.upload).is_dir():
            raise HTTPException(400, "no such upload")
        upload = UPLOADS / body.upload
        paths = [str(upload)]
    if not paths:
        raise HTTPException(400, "nothing to import")
    params: dict = {"paths": paths, "recursive": body.recursive, "copy": body.copy_files or upload is not None}
    if params["copy"] and body.jobcode and body.jobcode.strip():
        params["jobcode"] = body.jobcode.strip()
    try:
        r = await engine.call("import", **params)
    except EngineError as exc:
        if upload:
            shutil.rmtree(upload, ignore_errors=True)
        if "recursive" in str(exc) and not body.recursive:
            raise HTTPException(400, "no photos in this folder itself: tick “its subfolders too” to look in them")
        raise _bad(exc)
    IMPORTS[str(r.get("job"))] = {"upload": upload}
    return await _import_state(r)


async def _import_state(r: dict) -> dict:
    """A job's state; when it's over, its result in short and the upload's
    temporary folder removed."""
    out = {"job": r.get("job"), "state": r.get("state"), "error": r.get("error")}
    if r.get("state") in (None, "running"):
        return out
    res = r.get("result") or {}
    imported = res.get("imported") or []
    out.update(imported=len(imported), skipped=[{"file": Path(x.get("source", "")).name, "reason": x.get("reason")}
                                                for x in res.get("skipped") or []],
               failed=[{"file": Path(x.get("source", "")).name, "error": x.get("error")}
                       for x in res.get("failed") or []],
               film_ids=res.get("film_ids") or [], first=imported[0]["imgid"] if imported else None)
    done = IMPORTS.pop(str(r.get("job")), None)
    if done and done["upload"]:
        shutil.rmtree(done["upload"], ignore_errors=True)
    return out


@app.get("/api/import/{job}")
async def import_status(job: int):
    try:
        r = await engine.call("job_status", job=job)
    except EngineError as exc:
        raise _bad(exc, 404)
    return await _import_state({"job": job, **r})


@app.post("/api/import/{job}/cancel")
async def import_cancel(job: int):
    try:
        return await engine.call("job_cancel", job=job)
    except EngineError as exc:
        raise _bad(exc)


# ── the library lock ─────────────────────────────────────────────────────────

@app.get("/api/clients")
async def clients():
    """How many Claude sessions (clients that said kind "mcp") the engine has."""
    try:
        if not await engine.supports("clients"):
            return {"supported": False, "claude": 0}
        r = await engine.call("clients")
    except EngineError:
        return {"supported": False, "claude": 0}
    return {"supported": True, "claude": sum(1 for c in r.get("clients", []) if c.get("kind") == "mcp")}


@app.get("/api/library")
async def library_status():
    return await _library_state()


@app.post("/api/library/{action}")
async def library_action(action: str):
    """acquire: take back a library released to darktable's GUI;
    takeover: quit that GUI the normal way, then take it back."""
    try:
        if action == "acquire":
            return await engine.library("library_acquire")
        if action == "takeover":
            return await engine.takeover()
    except EngineError as exc:
        raise HTTPException(409, str(exc))
    raise HTTPException(404, f"no library action '{action}'")


@app.on_event("shutdown")
async def _shutdown():
    await engine.stop()
