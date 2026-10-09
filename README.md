# darktable-api-web

A small web app for browsing a [darktable](https://www.darktable.org/) library
and editing photos in the browser, phone included. The real work is done by
darktable itself: the app talks to **darktable-api**, a long-running headless
darktable built from darktable's own code, which renders previews, applies
edits and writes the history to the library exactly as darktable does.

**Experimental.** Use it on a copy of your library (the copy script below
does that). Saving writes darktable's history in the engine's module
versions, which an older darktable may not be able to read.

Written with AI assistance (Claude), directed and reviewed by the repository
owner.

## What it does

- **Library:** film rolls, filters (film roll, rating, color label), a
  thumbnail grid with paging; rate, reject and set color labels by click or
  keyboard (arrows, Enter, 0–5, R, F1–F5). Thumbnails come from darktable's
  own thumbnail cache, rendered with each photo's current edit.
- **Photo:** live preview from darktable's pipeline with sliders for exposure,
  AgX (or sigmoid, for photos edited with it) and color balance rgb; module
  on/off; history with undo/redo; save; discard unsaved; start over from
  darktable's defaults (your workflow and auto-apply presets); previous/next
  within the current filter.
- **Sharing the library with darktable:** darktable and the engine can't
  have one library open at the same time. The header has *release to
  darktable* (the engine closes the library; unsaved edits are kept), *take
  back*, and *quit darktable and take back* (asks darktable to quit the
  normal way, so it saves; never kills it).

Measured on an Apple M1 (CPU only) with a 20 MP raw: a preview after a slider
change takes 0.15–0.4 s at 1200 px; the first preview of a photo about 0.5 s.

## Requirements

1. **darktable-api**, from the `darktable-api` branch of the darktable fork:
   https://github.com/mmcc-xx/darktable/tree/darktable-api
   (see `src/api/README.md` there). Build darktable as usual with the MCP
   server enabled, which builds `darktable-api` alongside:

       git clone -b darktable-api --recurse-submodules https://github.com/mmcc-xx/darktable.git
       cd darktable
       cmake -B build -G Ninja -DUSE_MCP=ON
       cmake --build build --target darktable-api darktable

   darktable's README lists the build dependencies (on macOS:
   `brew bundle --file=.ci/Brewfile`). `darktable` (the GUI) from the same
   build is the one to open the library copy with.
2. Python 3.10 or later.

## Run

    python -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python make_library_copy.py          # ~/.config/darktable -> ./library-copy
    DTAPI_BIN=/path/to/darktable/build/bin/darktable-api \
        .venv/bin/uvicorn dtweb.main:app --port 8020

Then open http://127.0.0.1:8020. The engine starts on first use (a few
seconds) and stops after 10 minutes without requests.

`make_library_copy.py` copies `library.db`, `data.db` and `darktablerc`
(safe while darktable is running) and sets `write_sidecar_files=never` in the
copy, so nothing done here touches the XMP files next to your photos. Your
photos are only read. `--source` and `--dest` choose other folders.

| Variable | Default | |
|---|---|---|
| `DTAPI_BIN` | `darktable-api` on the PATH | the engine |
| `DTAPI_CONFIGDIR` | `library-copy/config` | the darktable config dir (library) the engine uses |
| `DTAPI_CACHEDIR` | `library-copy/cache` | the engine's darktable cache |
| `DTAPI_GUI_BIN` | `darktable` next to `DTAPI_BIN` | the only darktable *quit darktable and take back* may quit |

To open the copy in darktable's GUI: *release to darktable*, then

    /path/to/darktable/build/bin/darktable --configdir library-copy/config --cachedir library-copy/cache

**No authentication.** Keep it on 127.0.0.1, or put it behind something that
authenticates, before exposing it to a network.

## Layout

| | |
|---|---|
| `dtweb/engine.py` | runs darktable-api and talks JSON-RPC to it: one request at a time, edits before thumbnails, latest preview wins, restart on crash, the library hand-off |
| `dtweb/main.py` | FastAPI routes: library, thumbnails (cached by edit state), ratings/labels, photo editing, library hand-off |
| `dtweb/templates`, `dtweb/static` | pages (plain HTML and JavaScript, no framework) |
| `make_library_copy.py` | makes the library copy |

Tested on macOS. On Linux, *quit darktable and take back* uses darktable's
D-Bus `Quit` method (untested).

## See also

[darktable-api-mcp](https://github.com/mmcc-xx/darktable-api-mcp): an MCP
server on the same engine, for AI assistants. Give it its own library copy:
one engine per library.

## License

GPL-3.0, like darktable.
