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
import textwrap
import threading
import time
import zoneinfo
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from markupsafe import Markup
from pydantic import BaseModel

router = APIRouter()

DEFAULT_DIR = "/Users/clark/darktableluamcp/darktable-api"
FILES = {"queue": "QUEUE.md", "features": "FEATURES.md", "bugs": "BUGS.md", "done": "DONE.md",
         "queue-done": "QUEUE-done.md", "ideas": "IDEAS.md"}
TABS = [("queue", "queue"), ("features", "features"), ("bugs", "bugs"), ("done", "done"),
        ("ideas", "ideas"), ("queue-done", "queue done"), ("night", "night run"), ("forecast", "forecast")]
NUMERIC = {"Value", "Time", "Risk/enable", "CoD", "Size", "WSJF", "Est"}
SCORES = ["Value", "Time", "Risk/enable", "Size"]
EDITABLE = {"features": ["Item", "Area", "Value", "Time", "Risk/enable", "Size", "Est"],
            "bugs": ["Item", "Area", "Severity", "Found", "Est"],
            "ideas": ["Idea", "Serves", "Value", "Time", "Risk/enable", "Size"]}
OPEN = {"features": ("Open", "Parked"), "bugs": ("Open", "Parked"), "ideas": ("The list",)}   # sections with editable rows
IDEAS_SECTION = "From the web page"                                # where a new idea's bullet goes by default
SEVERITY = {"high": 3, "medium": 2, "low": 1}

CELL_SPLIT = re.compile(r"(?<!\\) \| ")
ROW = re.compile(r"^\| (\d+[ab]?|W\d+|[IP]\d+) \| .* \|$")
FINISHED = re.compile(r"^(~~.*?~~\s*)?\*\*(Done|Dropped|Closed)\b"          # as archive_backlog.py
                      r"|^\*\*[^*]*\bdone 20\d\d-\d\d-\d\d[^*]*\*\*"
                      r"|\*\*Done 20\d\d-\d\d-\d\d")
QITEM = re.compile(r"^- \[( |x|~|-)\] ")
QLABEL = re.compile(r"^- \[.\] \*\*(.+?)\*\*")
QEST = re.compile(r"\best\s*~?(\d+(?:\.\d+)?)")
QPARTIAL = re.compile(r"^ +- Partial")
QLEFT = re.compile(r"\bleft\s*~?(\d+(?:\.\d+)?)\b")
NO_EST = 1.0  # what forecast/queue_forecast.py counts for an unsized item
QUEUE_LABEL = re.compile(r"\*\*(#(\d+)|W(\d+))")
TOKEN = re.compile(r"(`[^`\n]+`|\*\*.+?\*\*)")
REF = re.compile(r"(?<![\w&/])(?:#(\d+[ab]?)|(W\d+|[IP]\d+))(?!\w)")
BULLET = re.compile(r"^- (\*\*.+?\*\*)")                                   # an idea's description: "- **I1 Title.** text"
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
            pnotes = [n for n in lines[i + 1:j] if QPARTIAL.match(n)]
            partial, left = bool(pnotes), QLEFT.search(pnotes[0]) if pnotes else None
            items.append({"section": name, "start": i, "end": j, "status": "partial" if status == "open" and partial else status,
                          "mark": m.group(1), "label": lab.group(1) if lab else "",
                          "text": lines[i][6:], "notes": lines[i + 1:j],
                          "est": est.group(1) if est else ("draft" if re.search(r"\best draft\b", lines[i]) else ""),
                          "left": left.group(1) if left else "", "lines": lines[i:j]})
            i = j
    return items


def pts_str(x: float) -> str:
    """Points for display: 1.0, 2.35, 0.05."""
    return f"{x:.2f}".rstrip("0").rstrip(".") if round(x, 1) != round(x, 2) else f"{x:.1f}"


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


def bullets(lines: list[str]) -> list[dict]:
    """IDEAS.md's description bullets ("- **I1 Title.** text", wrapped with a
    two-space indent): lines, the bold lead, the ids it covers ("I29-I32"
    covers four, owned by none), the text after the lead unwrapped."""
    out = []
    for i, l in enumerate(lines):
        m = BULLET.match(l)
        lm = m and re.match(r"\*\*([IP])(\d+)(?:-\1?(\d+))?(?=[\s*.,])", m.group(1))
        if not lm:
            continue
        j = i + 1
        while j < len(lines) and lines[j].startswith("  ") and lines[j].strip():
            j += 1
        a, z = int(lm.group(2)), int(lm.group(3) or lm.group(2))
        flat = " ".join(x.strip() for x in lines[i:j])[2:]
        out.append({"start": i, "end": j, "lead": m.group(1), "ids": {f"{lm.group(1)}{k}" for k in range(a, z + 1)},
                    "own": None if lm.group(3) else f"{lm.group(1)}{a}", "flat": flat,
                    "body": flat[len(m.group(1)):].strip(), "text": "\n".join(lines[i:j])})
    return out


def bullet_of(lines_or_bullets: list, rid: str) -> tuple[dict | None, bool]:
    """The idea's own bullet, else a shared one that covers it (True)."""
    bl = lines_or_bullets if lines_or_bullets and isinstance(lines_or_bullets[0], dict) else bullets(lines_or_bullets)
    for b in bl:
        if b["own"] == rid:
            return b, False
    return next(((b, True) for b in bl if rid in b["ids"]), (None, False))


def wrap_bullet(lead: str, body: str) -> list[str]:
    """One bullet at 76 columns; the lead stays whole on the first line."""
    text = "- " + lead.replace(" ", "\0") + (" " + body if body else "")
    return [l.replace("\0", " ") for l in textwrap.wrap(text, width=76, subsequent_indent="  ",
                                                          break_long_words=False, break_on_hyphens=False)]


# ── rendering helpers ───────────────────────────────────────────────────────

def link_index() -> dict[str, str]:
    """Row id -> the file that holds it (features, then bugs, then done)."""
    idx: dict[str, str] = {}
    for key in ("features", "bugs", "done", "ideas"):
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
            cells = [{"html": inline(shown(c), idx), "sort": sort_key(h, c), "long": h in ("Item", "Idea")}
                     for h, c in zip(t["header"], r["cells"])]
            can = (editable and t["section"] in OPEN.get(file_key, ("Open",)) and not r["done"]
                   and len(r["cells"]) == len(t["header"]))
            rows.append({"id": r["id"], "hash": sha(r["text"]), "cells": cells, "done": r["done"],
                         "raw": {h: shown(c) for h, c in zip(t["header"], r["cells"])},
                         "edit": can, "queue": can and file_key != "ideas" and r["id"] not in queued,
                         "delete": can and file_key == "ideas"})
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


RUN_START = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) run starting \(session \d+%, week (\d+)%, cap (\d+)%")
FC_HEAD = re.compile(r"cap (\d+)%, week ([\d.]+)% now, budget (-?[\d.]+) weekly points")


def rates_bias() -> float:
    """RATES.md's bias, as queue_forecast.py reads it."""
    m = re.search(r"Bias \(actual ÷ est\) ([\d.]+)", read_text("forecast/RATES.md"))
    return float(m.group(1)) if m else 1.0


# The weekly usage reset when /usage can't be read (Thursday 11pm EDT, 10pm
# EST; fixed in UTC), every 7 days, and daily-run.sh's PER_DAY.
WEEK_RESET = datetime.datetime(2026, 11, 6, 3, tzinfo=datetime.timezone.utc)
PER_DAY = 14
LOG_USAGE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (?:usage: |daily run: .*now )session \d+%, week (\d+)%")
USAGE_WEEK = re.compile(r"Current week[^:\n]*: (\d+)% used · resets (.+)")
RESET_AT = re.compile(r"(?:([A-Z][a-z]{2}) (\d+) at )?(\d+)(?::(\d\d))?([ap]m) \(([^)]+)\)")
_live: dict = {}                     # the last /usage reading: "at" (epoch), "when", "week", "reset"
_live_lock = threading.Lock()


def reset_time(text: str, now: datetime.datetime) -> datetime.datetime | None:
    """/usage's "Nov 5 at 10pm (America/New_York)" (or "2:10pm (...)") as the
    next such moment after now, as usage.zsh's reset_time reads it."""
    m = RESET_AT.search(text)
    if not m:
        return None
    try:
        n = now.astimezone(zoneinfo.ZoneInfo(m[6]))
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        return None
    t = n.replace(hour=int(m[3]) % 12 + (12 if m[5] == "pm" else 0), minute=int(m[4] or 0), second=0, microsecond=0)
    if m[1]:
        t = t.replace(month=datetime.datetime.strptime(m[1], "%b").month, day=int(m[2]))
        if t < n - datetime.timedelta(days=1):                # a January reset read in December
            t = t.replace(year=t.year + 1)
    elif t < n:
        t += datetime.timedelta(days=1)
    return t


def parse_usage(text: str, now: datetime.datetime) -> dict | None:
    """The week line of `claude -p /usage`: {"when", "week", "reset"}, or None."""
    m = USAGE_WEEK.search(text)
    if not m:
        return None
    return {"when": now.strftime("%Y-%m-%d %H:%M:%S"), "week": float(m[1]), "reset": reset_time(m[2], now)}


def live_usage(max_age: float = 60) -> dict | None:
    """The week % now, from `claude -p /usage` (about 3 s; no model call), at
    most once a max_age seconds; the last reading if it can't be read."""
    with _live_lock:
        if _live and time.time() - _live["at"] < max_age:
            return dict(_live)
        try:
            r = subprocess.run(["claude", "-p", "/usage"], capture_output=True, text=True, timeout=30,
                               cwd=tempfile.gettempdir())
            u = parse_usage(r.stdout + r.stderr, datetime.datetime.now().astimezone())
        except (subprocess.SubprocessError, OSError):
            u = None
        if u:
            _live.clear()
            _live.update(u, at=time.time())
        return dict(_live) if _live else None


def last_reset(t: datetime.datetime, anchor: datetime.datetime | None = None) -> datetime.datetime:
    """The weekly reset at or before t (anchor: any reset, e.g. /usage's next one)."""
    week, anchor = datetime.timedelta(days=7), anchor or WEEK_RESET
    return anchor + (t - anchor) // week * week


def day_cap(start: datetime.datetime, anchor: datetime.datetime | None = None) -> tuple[int, int]:
    """(day of the week, cap %) for a run starting at start, as daily-run.sh
    works it out: PER_DAY a day since the weekly reset, 100 from day 7;
    launchd/.cap-YYYY-MM-DD overrides it."""
    day = (start - last_reset(start, anchor)) // datetime.timedelta(days=1) + 1
    cap = 100 if day >= 7 else PER_DAY * day
    with contextlib.suppress(OSError, ValueError):
        cap = int((backlog_dir() / f"launchd/.cap-{start.date().isoformat()}").read_text().strip())
    return day, cap


def log_week() -> tuple[str, float] | None:
    """The newest week % in the night-run log's tail: (time, %), or None."""
    log = Path(os.environ.get("DTWEB_NIGHT_LOG") or Path.home() / "Library/Logs/darktable-night-run.log")
    try:
        with log.open("rb") as f:
            f.seek(max(0, f.seek(0, 2) - 262144))
            tail = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    hits = [m for m in map(LOG_USAGE.match, tail.splitlines()) if m]
    return (hits[-1].group(1), float(hits[-1].group(2))) if hits else None


def night_capacity() -> dict | None:
    """Weekly points left for tonight's run: cap - 1 - week, as daily-run.sh
    stops. The cap is today's run's (the night note's last "run starting"
    line) or forecast's (forecast/tonight.md), else worked out as daily-run.sh
    does (day_cap). The week % is the newest reading: the run start, runs.tsv
    (a run that ended since), the forecast, the night-run log, /usage
    (live_usage, read by the page); 0 if the week has reset since. While the
    forecast is the newest reading, its budget. {"pts", "cap", "week",
    "when", "src", "today"}, or None."""
    d, today = backlog_dir(), datetime.date.today().isoformat()
    reads: list[tuple[str, float, str]] = []           # (when, week %, from)
    cap = None                                          # (when, cap %, from) for today's run
    budget = None
    note = newest_night()
    if note:
        starts = [m for m in map(RUN_START.match, note.read_text(encoding="utf-8").splitlines()) if m]
        if starts:
            when, week, c = starts[-1].group(1), float(starts[-1].group(2)), int(starts[-1].group(3))
            reads.append((when, week, f"{note.name}, run started"))
            if when[:10] == today:
                cap = (when, c, f"run started {when[11:16]}")
            with contextlib.suppress(OSError, IndexError, ValueError):
                rows = (d / "forecast/runs.tsv").read_text(encoding="utf-8").splitlines()
                last = rows[-1].split("\t")
                if last[0] >= when and last[3] != "forecast":    # start, end, min, why, s0, w0, s1, w1
                    reads.append((last[1], float(last[7]), "runs.tsv, run ended"))
    fc = d / "forecast/tonight.md"
    if fc.exists():
        m = FC_HEAD.search(fc.read_text(encoding="utf-8"))
        when = datetime.datetime.fromtimestamp(fc.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        if m:
            reads.append((when, float(m.group(2)), "forecast/tonight.md"))
            if when[:10] == today and (cap is None or when > cap[0]):
                cap, budget = (when, int(m.group(1)), "forecast"), (when, float(m.group(3)))
    lw = log_week()
    if lw:
        reads.append((lw[0], lw[1], "the night-run log"))
    live = dict(_live)
    if live:
        reads.append((live["when"], live["week"], "/usage"))
    if not reads:
        return None
    when, week, src = max(reads)
    now = datetime.datetime.now().astimezone()
    anchor = live.get("reset")
    if cap is None:
        day, c = day_cap(datetime.datetime.combine(now.date(), datetime.time(18)).astimezone(), anchor)
        cap = (when, c, f"day {day} of the week")
    pts = cap[1] - 1 - week
    if datetime.datetime.fromisoformat(when).astimezone() < last_reset(now, anchor):
        week, pts, src = 0.0, cap[1] - 1, "the weekly reset since"
    elif budget and budget[0] == when:
        pts = budget[1]
    return {"pts": pts, "cap": cap[1], "week": week, "when": when, "today": True,
            "src": f"{cap[2]}; week % from {src}, {when[5:16]}"}


def mark_likely(opens: list[dict], budget: float, bias: float) -> None:
    """queue_forecast.py's walk: the first partial runs first, then the rest in
    order, each biased; sets it["likely"] to done / partial / not reached."""
    partial = [it for it in opens if it["status"] == "partial"][:1]
    total = 0.0
    for it in partial + [it for it in opens if it not in partial]:
        pts = it["pts_n"] * bias
        it["likely"] = "not reached" if total >= budget else "partial" if total + pts > budget else "done"
        total += pts


@router.get("/backlog", response_class=HTMLResponse)
async def backlog_page(request: Request, f: str = "queue"):
    from .main import _library_state, templates          # main imports this module: look it up late
    tab = f if f in dict(TABS) else "queue"
    d = backlog_dir()
    ctx: dict = {"tab": tab, "tabs": TABS, "dir": str(d), "locked": (d / "launchd/.daily-run.lock").exists(),
                 "error": None, "tables": [], "items": [], "texts": [], "qhash": "", "file": FILES.get(tab, ""),
                 "qtotal": "", "no_est": pts_str(NO_EST), "themes": [], "cap": None}
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
            total = 0.0
            for it in opens:                                 # points as queue_forecast.py counts them, before bias
                base = float(it["est"]) if it["est"] not in ("", "draft") else NO_EST
                pts = (float(it["left"]) if it["left"] else base * 0.5 + 0.3) if it["status"] == "partial" else base
                total += pts
                it["pts_n"], it["pts"], it["total"] = pts, pts_str(pts), pts_str(total)
            ctx["qtotal"] = pts_str(total)
            ctx["items"] = items
            with contextlib.suppress(OSError, ValueError):
                cap = night_capacity()
                if cap and opens:
                    b = rates_bias()
                    mark_likely(opens, cap["pts"], b)
                    cut = next((it for it in opens if it["likely"] != "done"), None)
                    if cut:
                        cut["cut"] = True
                    ctx["cap"] = {**cap, "pts": pts_str(cap["pts"]), "bias": b,
                                  "done": sum(it["likely"] == "done" for it in opens), "open": len(opens),
                                  "all_done": cut is None,
                                  "spare": pts_str(cap["pts"] - sum(it["pts_n"] * b for it in opens))}
        elif tab in ("features", "bugs", "done", "ideas"):
            lines = read_lines(FILES[tab])
            queued = queued_ids(read_lines("QUEUE.md")) if tab != "ideas" else set()
            ctx["tables"] = table_view(parse_tables(lines), tab, queued, idx, tab != "done")
            if tab == "ideas":                               # each idea's description bullet, shown when expanded
                ctx["themes"] = [n for n in sections(lines) if n not in OPEN["ideas"]]
                bl = bullets(lines)
                for tv in ctx["tables"]:
                    for row in tv["rows"]:
                        b, shared = bullet_of(bl, row["id"])
                        row["desc"] = {"text": b["body"], "hash": sha(b["text"]), "shared": shared and b["lead"]} if b else None
                        row["desc_html"] = inline(b["flat"] if shared else b["body"], idx) if b else ""
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
    cells: dict[str, str] = {}
    description: str | None = None      # ideas: the bullet's text after its bold lead
    desc_hash: str | None = None


def compute_scores(header: list[str], cells: list[str], two: bool = False) -> None:
    """CoD = value + time + risk/enable and WSJF = CoD / size, when all four are
    numbers. two: a WSJF that is exact in two decimals keeps them (1.75), as
    IDEAS.md writes it."""
    v = [num(cells[header.index(k)]) for k in SCORES]
    if None in v or not v[3]:
        return
    cod = int(round(v[0] + v[1] + v[2]))
    w = cod / v[3]
    cells[header.index("CoD")] = str(cod)
    exact2 = abs(w * 100 - round(w * 100)) < 1e-9 and round(w, 1) != round(w, 2)
    cells[header.index("WSJF")] = f"{w:.2f}" if two and exact2 else f"{w:.1f}"


def two_decimals(t: dict) -> bool:
    """Does this table write some WSJF values with two decimals?"""
    if "WSJF" not in t["header"]:
        return False
    k = t["header"].index("WSJF")
    return any(len(r["cells"]) > k and re.fullmatch(r"\d+\.\d\d", r["cells"][k]) for r in t["rows"])


def apply_edit(header: list[str], cells: list[str], new: dict[str, str], key: str, two: bool = False) -> list[str]:
    allowed = EDITABLE[key]
    out = list(cells)
    for col, val in new.items():
        if col not in allowed or col not in header:
            raise Reply(400, f"can't edit the column {col!r}")
        c = cell_text(val)
        if c != cells[header.index(col)] and c != cell_text(shown(cells[header.index(col)])):
            out[header.index(col)] = c
    if key in ("features", "ideas") and any(k in new for k in SCORES):
        compute_scores(header, out, two)
    return out


def do_edit(b: EditBody) -> dict:
    if b.file not in EDITABLE:
        raise Reply(400, "file must be features, bugs or ideas")
    name = FILES[b.file]
    lines = read_lines(name)
    t, r = find_row(lines, b.id, OPEN[b.file])
    if not r:
        raise Reply(409, f"{b.id} is no longer an open row of {name}", current="", yours=", ".join(
            f"{k}: {v}" for k, v in b.cells.items()))
    if len(r["cells"]) != len(t["header"]):
        raise Reply(400, "this row doesn't have the table's columns; edit it in the file")
    cells = apply_edit(t["header"], r["cells"], b.cells, b.file, b.file == "ideas" and two_decimals(t))
    if sha(r["text"]) != b.row_hash:
        raise Reply(409, "the row changed since you opened it; nothing was written",
                    current=r["text"], yours=join_cells(cells))
    bl, new_bullet = None, None
    if b.description is not None:
        if b.file != "ideas":
            raise Reply(400, "only ideas have a description")
        bl, _ = bullet_of(lines, b.id)
        if not bl:
            raise Reply(400, f"{b.id} has no description bullet in {name}; add one in the file")
        new_bullet = wrap_bullet(bl["lead"], " ".join(b.description.split()))
        if sha(bl["text"]) != b.desc_hash:
            raise Reply(409, "the description changed since you opened it; nothing was written",
                        current=bl["text"], yours="\n".join(new_bullet))
        if new_bullet == lines[bl["start"]:bl["end"]]:
            new_bullet = None
    if cells == r["cells"] and new_bullet is None:
        return {"changed": False}
    lines[r["line"]] = join_cells(cells)
    if new_bullet is not None:                             # below the list: the row's line number still holds
        lines[bl["start"]:bl["end"]] = new_bullet
    write_lines(name, lines)
    cols = [k for k in b.cells if cells[t["header"].index(k)] != r["cells"][t["header"].index(k)]]
    what = "scores" if cols and all(k in SCORES for k in cols) else ", ".join(c.lower() for c in cols)
    what = ", ".join(w for w in (what, "description" if new_bullet is not None else "") if w)
    return {"changed": True, "id": b.id, **commit([name], f"edit {label_of(b.id)} {what}")}


class AddBody(BaseModel):
    kind: str
    series: str
    title: str
    text: str = ""
    area: str | None = None
    scores: dict[str, str] | None = None
    severity: str | None = None
    section: str | None = None          # ideas: the ## theme for the description bullet


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
    if b.kind == "idea":
        return do_add_idea(b)
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


def next_idea_number(text: str, series: str) -> int:
    return max((int(n) for n in re.findall(rf"(?<![\w&/]){series}(\d+)(?!\w)", text)), default=0) + 1


def do_add_idea(b: AddBody) -> dict:
    """A row in IDEAS.md's list at its WSJF place (unscored: last) and a
    description bullet at the end of a ## theme section."""
    if b.series not in ("I", "P"):
        raise Reply(400, "series is I or P")
    title = cell_text(b.title).replace("**", "").strip().rstrip(".").strip()
    if not title:
        raise Reply(400, "a title is needed")
    name = FILES["ideas"]
    lines = read_lines(name)
    t = next((t for t in parse_tables(lines) if t["section"] in OPEN["ideas"]), None)
    if not t or not t["rows"]:
        raise Reply(400, f"{name} has no table under ## {OPEN['ideas'][0]}")
    sec = (b.section or "").strip() or IDEAS_SECTION
    if sec in OPEN["ideas"] or (sec != IDEAS_SECTION and sec not in sections(lines)):
        raise Reply(400, f"no theme section {sec!r} in {name}")
    rid = f"{b.series}{next_idea_number(chr(10).join(lines), b.series)}"
    sc = b.scores or {}
    row = {"#": rid, "Idea": title, "Serves": cell_text(b.area or "") or "?",
           **{k: cell_text(sc.get(k, "")) or "?" for k in SCORES}}
    header = t["header"]
    cells = [row.get(h, "?") for h in header]
    compute_scores(header, cells, two_decimals(t))
    w, k = num(cells[header.index("WSJF")]), header.index("WSJF")
    lower = [r["line"] for r in t["rows"] if w is not None and len(r["cells"]) > k
             and num(r["cells"][k]) is not None and num(r["cells"][k]) < w]
    lines.insert(lower[0] if lower else t["rows"][-1]["line"] + 1, join_cells(cells))
    body = " ".join(b.text.split())
    bullet = wrap_bullet(f"**{rid} {title}.**", (body + " " if body else "") + f"(Added {today()} from the web page.)")
    secs = sections(lines)
    if sec in secs:
        s, e = secs[sec]
        last = max((i for i in range(s + 1, e) if lines[i].strip()), default=s)
        top = last
        while top > s and lines[top].startswith("  "):
            top -= 1
        lines[last + 1:last + 1] = bullet if lines[top].startswith("- ") else [""] + bullet
    else:
        end = len(lines)
        while end and not lines[end - 1].strip():
            end -= 1
        lines[end:end] = ["", f"## {sec}", ""] + bullet
    write_lines(name, lines)
    return {"id": rid, "file": "ideas", **commit([name], f"add {rid} {title[:50]}")}


class DeleteBody(BaseModel):
    file: str
    id: str
    row_hash: str


def mentions_of(rid: str) -> list[dict]:
    """Lines of the backlog files that still name the id (alone or in a range like I29-I32)."""
    m = re.fullmatch(r"([IP])(\d+)", rid)
    one = re.compile(rf"(?<![\w&/]){rid}(?!\w)")
    rng = re.compile(rf"(?<![\w&/]){m.group(1)}(\d+)-{m.group(1)}?(\d+)(?!\w)")
    out = []
    for key in ("ideas", "features", "bugs", "queue"):
        with contextlib.suppress(OSError):
            for i, l in enumerate(read_lines(FILES[key])):
                if one.search(l) or any(int(a) <= int(m.group(2)) <= int(z) for a, z in rng.findall(l)):
                    out.append({"file": FILES[key], "line": i + 1, "text": l.strip()[:200]})
    return out[:40]


def do_delete(b: DeleteBody) -> dict:
    """Ideas only: the list's row and the idea's own bullet (a shared one stays)."""
    if b.file != "ideas":
        raise Reply(400, "only ideas can be deleted here")
    name = FILES["ideas"]
    lines = read_lines(name)
    t, r = find_row(lines, b.id, OPEN["ideas"])
    if not r:
        raise Reply(409, f"{b.id} is no longer in {name}'s list", current="", yours=f"delete {b.id}")
    if sha(r["text"]) != b.row_hash:
        raise Reply(409, "the row changed since you opened it; nothing was written",
                    current=r["text"], yours=f"delete {b.id}")
    title = shown(r["cells"][t["header"].index("Idea")]) if "Idea" in t["header"] else ""
    bl, shared = bullet_of(lines, b.id)
    cuts = [(r["line"], r["line"] + 1)] + ([(bl["start"], bl["end"])] if bl and not shared else [])
    for s, e in sorted(cuts, reverse=True):
        del lines[s:e]
        if 0 < s < len(lines) and not lines[s - 1].strip() and not lines[s].strip():
            del lines[s]                                  # the bullet was alone between blank lines
    s, e = sections(lines).get(IDEAS_SECTION, (None, None))
    if s is not None and not any(l.strip() for l in lines[s + 1:e]):   # the web page's section, now empty
        del lines[s:e]                                 # the blank line before it stays (or ends the file)
    write_lines(name, lines)
    return {"deleted": b.id, "mentions": mentions_of(b.id), **commit([name], f"delete {b.id} {title[:50]}")}


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


@router.get("/api/backlog/usage")
def backlog_usage():
    """The week % now (live_usage), for the queue tab to refresh its capacity."""
    u = live_usage()
    return JSONResponse({"week": u["week"], "when": u["when"]} if u else {"week": None})


@router.post("/api/backlog/edit")
def backlog_edit(body: EditBody):
    return run_write(do_edit, body)


@router.post("/api/backlog/add")
def backlog_add(body: AddBody):
    return run_write(do_add, body)


@router.post("/api/backlog/delete")
def backlog_delete(body: DeleteBody):
    return run_write(do_delete, body)


@router.post("/api/backlog/queue")
def backlog_queue(body: QueueBody):
    return run_write(do_queue, body)


@router.post("/api/backlog/move")
def backlog_move(body: MoveBody):
    return run_write(do_move, body)


@router.post("/api/backlog/unqueue")
def backlog_unqueue(body: UnqueueBody):
    return run_write(do_unqueue, body)
