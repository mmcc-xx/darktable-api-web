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
import os
import secrets
import tempfile

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .engine import CONFIG, EngineError, engine

HERE = Path(__file__).parent
app = FastAPI(title="darktable-api-web")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")
# the stylesheet's address changes with the file, so browsers don't keep an old one
templates.env.globals["static_version"] = lambda name: int((HERE / "static" / name).stat().st_mtime)

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
            "label": int(label) if label.isdigit() and int(label) < len(LABELS) else None}


def _query(f: dict) -> str:
    return "&".join(f"{k}={v}" for k, v in f.items() if v is not None)


def _list_args(f: dict) -> dict:
    return {"film_id": f["roll"] if f["roll"] is not None else -1, "rating": f["rating"],
            "label": f["label"] if f["label"] is not None else -1}


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
           "error": None}
    if ctx["lib"].get("state") == "owned":
        try:
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


def _tile(request: Request, img: dict):
    f = _filters(request)
    return templates.TemplateResponse(request, "_tile.html", {
        "img": img, "query": _query(f), "labels": LABELS, "version": _version})


# ── photo page ───────────────────────────────────────────────────────────────

async def _neighbours(image_id: int, f: dict) -> tuple[int | None, int | None, int, int]:
    """Previous and next image in the filtered list, position and total."""
    ids, offset, total = [], 0, 1
    while offset < total:
        r = await engine.call("images_list", offset=offset, limit=1000, **_list_args(f))
        total = r["total"]
        ids += [i["id"] for i in r["images"]]
        offset += 1000
    if image_id not in ids:
        return None, None, 0, len(ids)
    k = ids.index(image_id)
    return (ids[k - 1] if k else None), (ids[k + 1] if k + 1 < len(ids) else None), k + 1, len(ids)


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
           "prev": None, "next": None, "pos": 0, "total": 0, "error": None, "labels": LABELS, "shot": []}
    if lib.get("state") == "owned":
        try:
            info = await engine.call("image_info", imgid=image_id)
            ctx["img"], ctx["shot"] = info["image"], _shot(info.get("exif"))
            ctx["prev"], ctx["next"], ctx["pos"], ctx["total"] = await _neighbours(image_id, f)
        except EngineError as exc:
            ctx["error"] = str(exc)
    return templates.TemplateResponse(request, "photo.html", ctx)


async def _state(image_id: int) -> dict:
    listed = {m["operation"] for m in (await engine.edit(image_id, "module_list"))["modules"]}
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
    return {"modules": modules, "history": await engine.edit(image_id, "history_list"),
            "geometry": geometry, "mono": await _mono(image_id)}


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


@app.post("/api/photo/{image_id}/set")
async def photo_set(image_id: int, body: SetBody):
    try:
        r = await engine.edit(image_id, "module_set", operation=body.operation, values=body.values)
        return {**r, "history": await engine.edit(image_id, "history_list")}
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
    enabled: bool


@app.post("/api/photo/{image_id}/enable")
async def photo_enable(image_id: int, body: EnableBody):
    try:
        await engine.edit(image_id, "module_enable", operation=body.operation, enabled=body.enabled)
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


@app.post("/api/photo/{image_id}/export")
async def photo_export(image_id: int, body: ExportBody):
    params: dict = {"imgid": image_id, "save": body.save}
    if body.format:
        params["format"] = body.format
    if body.size is not None:
        params["max_width"] = params["max_height"] = max(0, body.size)
    if body.quality:
        params["quality"] = body.quality
    if body.high_quality is not None:
        params["high_quality"] = body.high_quality
    try:
        r = await engine.call("export", **params)
    except EngineError as exc:
        raise _bad(exc, 409 if "unsaved" in str(exc) else 400)
    if r.get("file"):
        token = secrets.token_urlsafe(12)
        EXPORTED[token] = Path(r["file"])
        r["download"] = f"/api/export/{token}/{Path(r['file']).name}"
    return r


@app.get("/api/export/{token}/{name}")
async def export_download(token: str, name: str):
    """A file this app exported, for the browser to save."""
    path = EXPORTED.get(token)
    if path is None or path.name != name or not path.is_file():
        raise HTTPException(404, "no such export (exports are offered for download until the web app restarts)")
    return FileResponse(path, filename=path.name)


@app.get("/api/photo/{image_id}/preview.jpg")
async def photo_preview(image_id: int, w: int = 1200, h: int = 1200, uncropped: bool = False):
    w, h = max(64, min(w, 2560)), max(64, min(h, 2560))
    try:
        r = await engine.render(image_id, w, h, uncropped)
    except EngineError as exc:
        raise _bad(exc, 502)
    if r is None:
        return Response(status_code=204)   # overtaken by a newer request
    data, timing = r
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "no-store",
        "X-Render-Ms": str(timing.get("process_ms", "")),
        "X-Total-Ms": str(timing.get("total_ms", ""))})


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


# ── the library lock ─────────────────────────────────────────────────────────

@app.get("/api/library")
async def library_status():
    return await _library_state()


@app.post("/api/library/{action}")
async def library_action(action: str):
    """release: hand the library to darktable's GUI; acquire: take it back;
    takeover: quit that GUI the normal way, then take it back."""
    try:
        if action == "release":
            return await engine.library("library_release")
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
