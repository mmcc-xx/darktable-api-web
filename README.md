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
        .venv/bin/uvicorn dtweb.main:app --port 8020 --timeout-graceful-shutdown 3

Then open http://127.0.0.1:8020. (`--timeout-graceful-shutdown` lets the
server stop while a browser keeps its live-update connection open.)

## One engine, several apps

The web app doesn't run darktable itself: it connects to a darktable-api
engine on a unix socket next to the library copy, and starts one if none is
running. [darktable-api-mcp](https://github.com/mmcc-xx/darktable-api-mcp)
pointed at the same library copy connects to the same engine, so an AI
assistant and the browser work on the same photos at the same time:

- a photo open in both is one shared edit: sliders in the browser and the
  AI's changes land in the same history, and whoever saves saves both;
- the page updates live when the AI (or another browser on another web app
  instance) edits the photo shown, rates it or changes its labels;
- **darktable's own window can serve the library too**, so you can edit in
  darktable, the browser and with the AI at the same time. Start darktable
  (built from the same fork) with `--api-socket` pointing at the same socket:

      /path/to/darktable/build/bin/darktable --configdir library-copy/config \
          --cachedir library-copy/cache --api-socket library-copy/darktable-api.sock

  It takes over from a running engine automatically (unsaved edits
  included); the photo open in its darkroom is shared live with the browser
  (sliders move in both directions); when darktable quits, the apps go back
  to the engine. The header then says "served by darktable's window";
- the engine keeps up to 3 photos open (`DTAPI_MAX_SESSIONS`) and stops 10
  minutes after the last app disconnected (`DTAPI_IDLE_EXIT`), unless
  something is unsaved.

`make_library_copy.py` copies `library.db`, `data.db` and `darktablerc`
(safe while darktable is running) and sets `write_sidecar_files=never` in the
copy, so nothing done here touches the XMP files next to your photos. Your
photos are only read. `--source` and `--dest` choose other folders.

| Variable | Default | |
|---|---|---|
| `DTAPI_BIN` | `darktable-api` on the PATH | the engine |
| `DTAPI_CONFIGDIR` | `library-copy/config` | the darktable config dir (library) the engine uses |
| `DTAPI_CACHEDIR` | `library-copy/cache` | the engine's darktable cache |
| `DTAPI_SOCKET` | `library-copy/darktable-api.sock` (or `/tmp/darktable-api-<uid>-<hash>.sock` if that path is too long) | where the engine listens; every app using the library must use the same one |
| `DTAPI_MAX_SESSIONS`, `DTAPI_IDLE_EXIT` | 3, 600 | used when this app starts the engine |
| `DTAPI_GUI_BIN` | `darktable` next to `DTAPI_BIN` | the only darktable *quit darktable and take back* may quit |

To open the copy in darktable's GUI: *release to darktable*, then

    /path/to/darktable/build/bin/darktable --configdir library-copy/config --cachedir library-copy/cache

**No authentication.** Keep it on 127.0.0.1, or put it behind something that
authenticates, before exposing it to a network.

## Layout

| | |
|---|---|
| `dtweb/engine.py` | connects to the darktable-api engine (starting it if needed) and talks JSON-RPC to it: edits before thumbnails, latest preview wins, events from other apps, the library hand-off |
| `dtweb/main.py` | FastAPI routes: library, thumbnails (cached by edit state), ratings/labels, photo editing, live updates (server-sent events), library hand-off |
| `dtweb/templates`, `dtweb/static` | pages (plain HTML and JavaScript, no framework) |
| `make_library_copy.py` | makes the library copy |

Tested on macOS. On Linux, *quit darktable and take back* uses darktable's
D-Bus `Quit` method (untested).

## License

GPL-3.0, like darktable.
