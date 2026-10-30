"""The backlog page (/backlog): read the darktable-api backlog files, sort
them, and edit, add, queue and reorder items. Every write changes one
Markdown file, atomically, under a lock, and is committed (not pushed) in the
repo the folder belongs to.

The folder is DTWEB_BACKLOG_DIR (default: darktable-api in the darktableluamcp
checkout). Standard library only: the Markdown here is the backlog's own
small dialect (tables, `- [ ]` queue items, **bold**, `code`).
"""

from __future__ import annotations

import contextlib
import datetime
import fcntl
import hashlib
import html
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from markupsafe import Markup
from pydantic import BaseModel

router = APIRouter()

DEFAULT_DIR = "/Users/clark/darktableluamcp/darktable-api"
FILES = {"queue": "QUEUE.md", "features": "FEATURES.md", "bugs": "BUGS.md", "done": "DONE.md",
         "queue-done": "QUEUE-done.md"}
TABS = [("queue", "queue"), ("features", "features"), ("bugs", "bugs"), ("done", "done"),
        ("queue-done", "queue done"), ("night", "night run"), ("forecast", "forecast")]
NUMERIC = {"Value", "Time", "Risk/enable", "CoD", "Size", "WSJF", "Est"}
SCORES = ["Value", "Time", "Risk/enable", "Size"]
EDITABLE = {"features": ["Item", "Area", "Value", "Time", "Risk/enable", "Size", "Est"],
            "bugs": ["Item", "Area", "Severity", "Found", "Est"]}
SEVERITY = {"high": 3, "medium": 2, "low": 1}

CELL_SPLIT = re.compile(r"(?<!\\) \| ")
ROW = re.compile(r"^\| (\d+[ab]?|W\d+) \| .* \|$")
FINISHED = re.compile(r"^(~~.*?~~\s*)?\*\*(Done|Dropped|Closed)\b"          # as archive_backlog.py
                      r"|^\*\*[^*]*\bdone 20\d\d-\d\d-\d\d[^*]*\*\*"
                      r"|\*\*Done 20\d\d-\d\d-\d\d")
QITEM = re.compile(r"^- \[( |x|~|-)\] ")
QLABEL = re.compile(r"^- \[.\] \*\*(.+?)\*\*")
QEST = re.compile(r"\best\s*~?(\d+(?:\.\d+)?)")
QPARTIAL = re.compile(r"^ +- Partial")
QUEUE_LABEL = re.compile(r"\*\*(#(\d+)|W(\d+))")
TOKEN = re.compile(r"(`[^`\n]+`|\*\*.+?\*\*)")
REF = re.compile(r"(?<![\w&/])(?:#(\d+[ab]?)|(W\d+))(?!\w)")
NUMBER = re.compile(r"\d+(?:\.\d+)?")

_thread_lock = threading.Lock()


# ── errors and the write guard ──────────────────────────────────────────────

class Reply(Exception):
    """A non-200 answer: status and JSON body."""

    def __init__(self, status: int, error: str, **extra):
        super().__init__(error)
        self.status, self.body = status, {"error": error, **extra}


def backlog_dir() -> Path:
    return Path(os.environ.get("DTWEB_BACKLOG_DIR") or DEFAULT_DIR)


@contextlib.contextmanager
def write_guard():
    """One writer at a time (threads, then other processes), and none while a
    night run holds its lock directory."""
    d = backlog_dir()
    with _thread_lock:
        if (d / "launchd/.daily-run.lock").exists():
            raise Reply(423, "a night run is working on the backlog; try again after it ends")
        with open(d / ".backlog-web.lock", "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield d
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)


def read_text(name: str) -> str:
    with open(backlog_dir() / name, encoding="utf-8", newline="") as fh:
        return fh.read()


def read_lines(name: str) -> list[str]:
    return read_text(name).split("\n")          # not splitlines(): that splits on more than "\n"


def write_lines(name: str, lines: list[str]) -> None:
    """Temp file next to it, fsync, rename over it; the other bytes untouched."""
    path = backlog_dir() / name
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write("\n".join(lines))
            fh.flush()
            os.fsync(fh.fileno())
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def sha(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def commit(names: list[str], what: str) -> dict:
    """Commit just these files in the folder's repo; never pushes. A failure
    leaves the write in place and comes back as a warning."""
    git = shutil.which("git") or "/usr/bin/git"
    d = backlog_dir()
    try:
        top = subprocess.run([git, "-C", str(d), "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, timeout=30, check=True).stdout.strip()
        rel = [os.path.relpath(os.path.realpath(d / n), os.path.realpath(top)) for n in names]
        r = subprocess.run([git, "-C", top, "commit", "-q", "--only", "-m", f"backlog: {what}, from the web page",
                            "--", *rel], capture_output=True, text=True, timeout=60)
        if r.returncode:
            return {"warning": "written, but the commit failed: " + (r.stderr or r.stdout).strip()}
        h = subprocess.run([git, "-C", top, "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                           timeout=30, check=True).stdout.strip()
        return {"commit": h}
    except (subprocess.SubprocessError, OSError) as exc:
        return {"warning": f"written, but the commit failed: {exc}"}


# ── parsing ─────────────────────────────────────────────────────────────────

def split_cells(line: str) -> list[str]:
    return CELL_SPLIT.split(line[2:-2])


def join_cells(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def sections(lines: list[str]) -> dict[str, tuple[int, int]]:
    """'## Name' -> (heading line, end line exclusive)."""
    heads = [(i, l[3:].strip()) for i, l in enumerate(lines) if l.startswith("## ")]
    return {name: (i, heads[k + 1][0] if k + 1 < len(heads) else len(lines)) for k, (i, name) in enumerate(heads)}


def parse_tables(lines: list[str]) -> list[dict]:
    """Every table: caption, section, header names, rows (line index, id, cells)."""
    tables, section, caption, i = [], "", "", 0
    while i < len(lines):
        l = lines[i]
        if l.startswith("## "):
            section = caption = l[3:].strip()
        elif l.startswith("| #") and i + 1 < len(lines) and lines[i + 1].startswith("|---"):
            t = {"caption": caption, "section": section, "header": split_cells(l), "rows": []}
            i += 2
            while i < len(lines) and lines[i].startswith("| "):
                if ROW.match(lines[i]):
                    cells = split_cells(lines[i])
                    t["rows"].append({"line": i, "id": cells[0], "cells": cells, "text": lines[i],
                                      "done": bool(FINISHED.search(" | ".join(cells[1:])))})
                i += 1
            tables.append(t)
            continue
        elif l.strip() and not l.startswith("#") and len(l) < 60 and l.endswith(":"):
            caption = f"{section} · {l[:-1]}"
        i += 1
    return tables


def find_row(lines: list[str], rid: str, sections_wanted=("Open", "Parked")):
    for t in parse_tables(lines):
        if t["section"] in sections_wanted:
            for r in t["rows"]:
                if r["id"] == rid:
                    return t, r
    return None, None


def parse_queue(lines: list[str]) -> list[dict]:
    """Queue items of both sections with their blocks (the item line and the
    indented lines under it)."""
    items, secs = [], sections(lines)
    for name in ("Queue", "Deferred"):
        if name not in secs:
            continue
        start, end = secs[name]
        i = start + 1
        while i < end:
            m = QITEM.match(lines[i])
            if not m:
                i += 1
                continue
            j = i + 1
            while j < end and lines[j].startswith(" ") and lines[j].strip():
                j += 1
            lab, est = QLABEL.match(lines[i]), QEST.search(lines[i])
            status = {" ": "open", "x": "done", "~": "skipped", "-": "deferred"}[m.group(1)]
            partial = any(QPARTIAL.match(n) for n in lines[i + 1:j])
            items.append({"section": name, "start": i, "end": j, "status": "partial" if status == "open" and partial else status,
                          "mark": m.group(1), "label": lab.group(1) if lab else "",
                          "text": lines[i][6:], "notes": lines[i + 1:j],
                          "est": est.group(1) if est else ("draft" if re.search(r"\best draft\b", lines[i]) else ""),
                          "lines": lines[i:j]})
            i = j
    return items


def is_open(item: dict) -> bool:
    return item["section"] == "Queue" and item["mark"] == " "


def label_of(rid: str) -> str:
    rid = rid.lstrip("#")
    return f"#{rid}" if rid.isdigit() or rid[:-1].isdigit() else rid


def queued_ids(lines: list[str]) -> set[str]:
    """Row ids named by an open queue item's bold label."""
    out = set()
    for it in parse_queue(lines):
        if is_open(it):
            out |= {a or b for a, b in re.findall(r"#(\d+[ab]?)|\b(W\d+)\b", it["label"])}
    return out


def queue_section_text(lines: list[str]) -> str:
    s, e = sections(lines)["Queue"]
    return "\n".join(lines[s:e])


# ── rendering helpers ───────────────────────────────────────────────────────

def link_index() -> dict[str, str]:
    """Row id -> the file that holds it (features, then bugs, then done)."""
    idx: dict[str, str] = {}
    for key in ("features", "bugs", "done"):
        try:
            for t in parse_tables(read_lines(FILES[key])):
                for r in t["rows"]:
                    idx.setdefault(r["id"], key)
        except OSError:
            pass
    return idx


def inline(text: str, idx: dict[str, str] | None = None) -> Markup:
    """Escape, then render **bold**, `code` and item references (#12, W45)."""
    idx = idx or {}

    def plain(s: str) -> str:
        s = html.escape(s)

        def ref(m):
            rid = m.group(1) or m.group(2)
            f = idx.get(rid)
            return f'<a href="/backlog?f={f}#r-{rid}">{m.group(0)}</a>' if f else m.group(0)
        return REF.sub(ref, s)

    out = []
    for part in TOKEN.split(text):
        if part.startswith("`") and TOKEN.fullmatch(part):
            out.append(f"<code>{html.escape(part[1:-1])}</code>")
        elif part.startswith("**") and TOKEN.fullmatch(part):
            out.append(f"<b>{inline(part[2:-2], idx)}</b>")
        else:
            out.append(plain(part))
    return Markup("".join(out))


def shown(cell: str) -> str:
    return cell.replace("\\|", "|")


def sort_key(col: str, cell: str) -> str:
    if col == "#":
        return str((10000 if cell.startswith("W") else 0) + int(re.sub(r"\D", "", cell) or 0))
    if col == "Severity":
        return str(SEVERITY.get(cell.strip().lower(), 0))
    if col in NUMERIC:
        m = NUMBER.search(cell)
        return m.group(0) if m else ""
    return cell.lower()


def col_type(col: str) -> str:
    return "num" if col in NUMERIC or col == "#" else "sev" if col == "Severity" else "txt"


def table_view(tables: list[dict], file_key: str, queued: set[str], idx: dict, editable: bool) -> list[dict]:
    out = []
    for t in tables:
        rows = []
        for r in t["rows"]:
            cells = [{"html": inline(shown(c), idx), "sort": sort_key(h, c), "long": h == "Item"}
                     for h, c in zip(t["header"], r["cells"])]
            can = editable and t["section"] == "Open" and not r["done"] and len(r["cells"]) == len(t["header"])
            rows.append({"id": r["id"], "hash": sha(r["text"]), "cells": cells, "done": r["done"],
                         "raw": {h: shown(c) for h, c in zip(t["header"], r["cells"])},
                         "edit": can, "queue": can and r["id"] not in queued})
        out.append({"caption": t["caption"], "header": t["header"], "types": [col_type(h) for h in t["header"]],
                    "rows": rows})
    return out


def num(s: str) -> float | None:
    s = s.strip()
    return float(s) if re.fullmatch(r"\d+(?:\.\d+)?", s) else None


def cell_text(s: str) -> str:
    if not isinstance(s, str) or "\n" in s or "\r" in s:
        raise Reply(400, "a cell is one line: no line breaks")
    return re.sub(r"(?<!\\)\|", r"\\|", s.strip())


# ── pages ───────────────────────────────────────────────────────────────────

def newest_night() -> Path | None:
    files = sorted(backlog_dir().glob("night-run-*.md"))
    return files[-1] if files else None


@router.get("/backlog", response_class=HTMLResponse)
async def backlog_page(request: Request, f: str = "queue"):
    from .main import _library_state, templates          # main imports this module: look it up late
    tab = f if f in dict(TABS) else "queue"
    d = backlog_dir()
    ctx: dict = {"tab": tab, "tabs": TABS, "dir": str(d), "locked": (d / "launchd/.daily-run.lock").exists(),
                 "error": None, "tables": [], "items": [], "texts": [], "qhash": "", "file": FILES.get(tab, "")}
    try:
        idx = link_index()
        if tab == "queue":
            lines = read_lines("QUEUE.md")
            ctx["qhash"] = sha(queue_section_text(lines))
            items = parse_queue(lines)
            opens = [it for it in items if is_open(it)]
            for it in items:
                it["html"] = inline(it["text"], idx)
                it["notes_html"] = [inline(n.strip(), idx) for n in it["notes"]]
                it["can"] = is_open(it)
                it["first"], it["last"] = it is opens[0], it is opens[-1]
            ctx["items"] = items
        elif tab in ("features", "bugs", "done"):
            lines = read_lines(FILES[tab])
            queued = queued_ids(read_lines("QUEUE.md"))
            ctx["tables"] = table_view(parse_tables(lines), tab, queued, idx, tab != "done")
        elif tab == "queue-done":
            ctx["texts"] = [("QUEUE-done.md", inline_block(read_text("QUEUE-done.md"), idx))]
        elif tab == "night":
            p = newest_night()
            ctx["texts"] = [(p.name, inline_block(p.read_text(encoding="utf-8"), idx))] if p else []
        else:
            for name in ("forecast/tonight.md", "forecast/.latest"):
                if (d / name).exists():
                    ctx["texts"].append((name, inline_block((d / name).read_text(encoding="utf-8"), idx)))
    except (OSError, KeyError) as exc:
        ctx["error"] = f"can't read the backlog files in {d}: {exc}"
    try:
        lib = await _library_state()
    except Exception as exc:                                # the page doesn't need the engine
        lib = {"state": "unavailable", "detail": str(exc)}
    return templates.TemplateResponse(request, "backlog.html", {**ctx, "lib": lib})


def inline_block(text: str, idx: dict) -> Markup:
    return inline(text, idx)


# ── writes ──────────────────────────────────────────────────────────────────

def run_write(fn, body):
    try:
        with write_guard():
            return JSONResponse(fn(body))
    except Reply as r:
        return JSONResponse(r.body, status_code=r.status)
    except OSError as exc:
        return JSONResponse({"error": f"can't write the backlog files: {exc}"}, status_code=500)


def today() -> str:
    return datetime.date.today().isoformat()


class EditBody(BaseModel):
    file: str
    id: str
    row_hash: str
    cells: dict[str, str]


def compute_scores(header: list[str], cells: list[str]) -> None:
    """CoD = value + time + risk/enable and WSJF = CoD / size, when all four are numbers."""
    v = [num(cells[header.index(k)]) for k in SCORES]
    if None in v or not v[3]:
        return
    cod = int(round(v[0] + v[1] + v[2]))
    cells[header.index("CoD")] = str(cod)
    cells[header.index("WSJF")] = f"{cod / v[3]:.1f}"


def apply_edit(header: list[str], cells: list[str], new: dict[str, str], key: str) -> list[str]:
    allowed = EDITABLE[key]
    out = list(cells)
    for col, val in new.items():
        if col not in allowed or col not in header:
            raise Reply(400, f"can't edit the column {col!r}")
        c = cell_text(val)
        if c != cells[header.index(col)] and c != cell_text(shown(cells[header.index(col)])):
            out[header.index(col)] = c
    if key == "features" and any(k in new for k in SCORES):
        compute_scores(header, out)
    return out


def do_edit(b: EditBody) -> dict:
    if b.file not in EDITABLE:
        raise Reply(400, "file must be features or bugs")
    name = FILES[b.file]
    lines = read_lines(name)
    t, r = find_row(lines, b.id)
    if not r:
        raise Reply(409, f"{b.id} is no longer an open row of {name}", current="", yours=", ".join(
            f"{k}: {v}" for k, v in b.cells.items()))
    if len(r["cells"]) != len(t["header"]):
        raise Reply(400, "this row doesn't have the table's columns; edit it in the file")
    cells = apply_edit(t["header"], r["cells"], b.cells, b.file)
    if sha(r["text"]) != b.row_hash:
        raise Reply(409, "the row changed since you opened it; nothing was written",
                    current=r["text"], yours=join_cells(cells))
    if cells == r["cells"]:
        return {"changed": False}
    lines[r["line"]] = join_cells(cells)
    write_lines(name, lines)
    cols = [k for k in b.cells if cells[t["header"].index(k)] != r["cells"][t["header"].index(k)]]
    what = "scores" if cols and all(k in SCORES for k in cols) else ", ".join(c.lower() for c in cols)
    return {"changed": True, "id": b.id, **commit([name], f"edit {label_of(b.id)} {what}")}


class AddBody(BaseModel):
    kind: str
    series: str
    title: str
    text: str = ""
    area: str | None = None
    scores: dict[str, str] | None = None
    severity: str | None = None


def next_number(series: str) -> int:
    best = 0
    for key in ("features", "bugs", "done"):
        for t in parse_tables(read_lines(FILES[key])):
            for r in t["rows"]:
                m = re.fullmatch(r"(W?)(\d+)[ab]?", r["id"])
                if m and m.group(1) == ("W" if series == "W" else ""):
                    best = max(best, int(m.group(2)))
    for key in ("QUEUE.md", "QUEUE-done.md"):
        for m in QUEUE_LABEL.finditer(read_text(key)):
            if series == "#" and m.group(2):
                best = max(best, int(m.group(2)))
            elif series == "W" and m.group(3):
                best = max(best, int(m.group(3)))
    return best + 1


def do_add(b: AddBody) -> dict:
    if b.kind not in ("feature", "bug") or b.series not in ("#", "W"):
        raise Reply(400, "kind is feature or bug; series is # or W")
    title = cell_text(b.title).replace("**", "").strip()
    text = cell_text(b.text)
    if not title:
        raise Reply(400, "a title is needed")
    key = "features" if b.kind == "feature" else "bugs"
    name = FILES[key]
    n = next_number(b.series)
    rid = f"W{n}" if b.series == "W" else str(n)
    item = f"**{title}** (added {today()} from the web page, draft)" + (f": {text}" if text else "")
    area = cell_text(b.area or "") or "?"
    if key == "features":
        sc = b.scores or {}
        vals = [cell_text(sc.get(k, "")) or "?" for k in SCORES]
        cells = [rid, item, area, vals[0], vals[1], vals[2], "?", vals[3], "?", "draft"]
        compute_scores(["#", "Item", "Area", "Value", "Time", "Risk/enable", "CoD", "Size", "WSJF", "Est"], cells)
    else:
        sev = (b.severity or "medium").strip().lower()
        if sev not in SEVERITY:
            raise Reply(400, "severity is high, medium or low")
        cells = [rid, item, area, sev, today(), "draft"]
    lines = read_lines(name)
    s, e = sections(lines).get("Open", (None, None))
    if s is None:
        raise Reply(400, f"{name} has no ## Open section")
    last = max((i for i in range(s, e) if lines[i].startswith("| ")), default=None)
    if last is None:
        raise Reply(400, f"{name}'s Open section has no table")
    lines.insert(last + 1, join_cells(cells))
    write_lines(name, lines)
    return {"id": label_of(rid), "file": key, **commit([name], f"add {label_of(rid)} {title[:50]}")}


class QueueBody(BaseModel):
    id: str
    file: str


def do_queue(b: QueueBody) -> dict:
    if b.file not in EDITABLE:
        raise Reply(400, "file must be features or bugs")
    src = FILES[b.file]
    rid = b.id.lstrip("#")
    t, r = find_row(read_lines(src), rid)
    if not r:
        raise Reply(404, f"{rid} is not an open row of {src}")
    lines = read_lines("QUEUE.md")
    label = label_of(rid)
    if rid in queued_ids(lines):
        raise Reply(409, f"{label} is already an open item in the queue")
    item = shown(r["cells"][t["header"].index("Item")]) if "Item" in t["header"] else ""
    m = re.search(r"\*\*(.+?)\*\*", item)
    title = m.group(1) if m else item[:80].rstrip()
    est = NUMBER.search(r["cells"][t["header"].index("Est")]) if "Est" in t["header"] else None
    new = f"- [ ] **{label}** {title} (row in {src}); queued {today()} from the web page. est {est.group(0) if est else 'draft'}"
    secs = sections(lines)
    if "Queue" not in secs:
        raise Reply(400, "QUEUE.md has no ## Queue section")
    s, e = secs["Queue"]
    queue_items = [it for it in parse_queue(lines) if it["section"] == "Queue"]
    at = queue_items[-1]["end"] if queue_items else max(i for i in range(s, e) if lines[i].strip()) + 1
    lines.insert(at, new)
    write_lines("QUEUE.md", lines)
    return {"label": label, **commit(["QUEUE.md"], f"queue {label}")}


class MoveBody(BaseModel):
    label: str
    dir: str
    queue_hash: str


def open_item(lines: list[str], label: str) -> tuple[list[dict], int]:
    opens = [it for it in parse_queue(lines) if is_open(it)]
    for i, it in enumerate(opens):
        if it["label"] == label:
            return opens, i
    raise Reply(404, f"no open queue item {label!r}")


def check_queue(lines: list[str], qhash: str, yours: str) -> None:
    cur = queue_section_text(lines)
    if sha(cur) != qhash:
        raise Reply(409, "the queue changed since you opened it; nothing was written", current=cur, yours=yours)


def do_move(b: MoveBody) -> dict:
    if b.dir not in ("up", "down"):
        raise Reply(400, "dir is up or down")
    lines = read_lines("QUEUE.md")
    check_queue(lines, b.queue_hash, f"move {b.label} {b.dir}")
    opens, i = open_item(lines, b.label)
    j = i - 1 if b.dir == "up" else i + 1
    if not 0 <= j < len(opens):
        raise Reply(400, f"{b.label} is already {'first' if b.dir == 'up' else 'last'}")
    a, c = sorted((opens[i], opens[j]), key=lambda x: x["start"])
    lines[a["start"]:c["end"]] = c["lines"] + lines[a["end"]:c["start"]] + a["lines"]
    write_lines("QUEUE.md", lines)
    return {"label": b.label, **commit(["QUEUE.md"], f"move {b.label} {b.dir}")}


class UnqueueBody(BaseModel):
    label: str
    queue_hash: str


def do_unqueue(b: UnqueueBody) -> dict:
    lines = read_lines("QUEUE.md")
    check_queue(lines, b.queue_hash, f"unqueue {b.label}")
    opens, i = open_item(lines, b.label)
    it = opens[i]
    block = ["- [-] " + it["lines"][0][6:]] + it["lines"][1:]
    del lines[it["start"]:it["end"]]
    secs = sections(lines)
    if "Deferred" not in secs:
        raise Reply(400, "QUEUE.md has no ## Deferred section")
    s, e = secs["Deferred"]
    filled = [k for k in range(s + 1, e) if lines[k].strip()]
    if filled:
        lines[filled[-1] + 1:filled[-1] + 1] = block
    else:
        lines[s + 1:s + 1] = [""] + block
    write_lines("QUEUE.md", lines)
    return {"label": b.label, **commit(["QUEUE.md"], f"unqueue {b.label}")}


@router.post("/api/backlog/edit")
def backlog_edit(body: EditBody):
    return run_write(do_edit, body)


@router.post("/api/backlog/add")
def backlog_add(body: AddBody):
    return run_write(do_add, body)


@router.post("/api/backlog/queue")
def backlog_queue(body: QueueBody):
    return run_write(do_queue, body)


@router.post("/api/backlog/move")
def backlog_move(body: MoveBody):
    return run_write(do_move, body)


@router.post("/api/backlog/unqueue")
def backlog_unqueue(body: UnqueueBody):
    return run_write(do_unqueue, body)
