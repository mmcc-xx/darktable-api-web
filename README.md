# darktable-api-web

A small web app for browsing a [darktable](https://www.darktable.org/) library
and editing photos in the browser, phone included. The real work is done by
darktable itself: the app talks to **darktable-api**, a long-running headless
darktable built from darktable's own code, which renders previews, applies
edits and writes the history to the library exactly as darktable does.

**Experimental.** Use it on a copy of your library (the copy script below
does that). Saving writes darktable's history in the engine's module
versions, which an older darktable may not be able to read.

darktable-api is three repositories: the
[darktable fork](https://github.com/mmcc-xx/darktable/tree/darktable-api)
(the engine), [darktable-api-mcp](https://github.com/mmcc-xx/darktable-api-mcp)
(an MCP server for AI assistants, and the setup instructions for all three)
and this web app. [Demo video](https://www.youtube.com/watch?v=VDfZbxvvniY)

Written with AI assistance (Claude), directed and reviewed by the repository
owner.

## What it does

Desktop and phone (up to 800 px wide the darkroom is one column with the
edit panel as a sheet; swipe for the next photo, pinch to zoom).

- **Library:** film rolls, filters (film roll, rating, color label, tag:
  a tag also takes the tags under it, `places` takes `places|paris`), a
  thumbnail grid from darktable's own thumbnail cache. A click shows a
  photo in the detail panel (above 1400 px a large preview beside the grid,
  details in a drawer): rating and labels, camera and exposure, title,
  description and tags to edit, *open in darkroom*, duplicate, export, and
  its library id (a click copies "photo 431" for an AI). ⌘/Ctrl-click or a
  tile's box selects (shift: a range, ⌘/Ctrl+A, Esc); a bar then rates,
  labels, tags, duplicates, exports, saves to the phone's photos or makes a
  **panorama** (Hugin, after a check of what would make seams show). Keys:
  arrows, 0–5, R, F1–F5, ⌘/Ctrl+D (duplicate), f (full screen), o (sensor
  clipping from the raw file over the preview; tiles get a chip for clipped
  or blocked photos). AI fill patches are hidden (pick their
  `darktable_fills` roll to see them). On a phone, a long press on a tile
  saves the photo to the photo library.
- **Full screen:** the photo alone on black, from the lighttable or the
  darkroom; rate, prev/next (arrows, swipe), pinch or wheel zoom.
- **Import:** *import…* in the library's header: a folder on this
  computer (its subfolders too if asked), added where it is or copied into
  darktable's import folders (*copy & import*, with a job code), or files
  uploaded from the browser (resumable, with progress). Uploads start with
  a review grid (previews from the files themselves): rejected photos
  aren't sent, and are remembered so the same card comes up with them
  rejected. Photos already in the library are skipped, as darktable does.
- **Darkroom:** a toolbar above the photo and a panel at the right. The
  panel: an RGB + luminance histogram with clipped shares and rgb levels'
  handles and pickers, the camera data, then two views. Each module's panel
  has a button for every picker the engine has: click the photo for a small
  area or drag a box. *Quick*: exposure,
  white balance (color calibration as temperature and tint, *pick a neutral
  spot*), AgX (or sigmoid), the tone equalizer's nine bands, color balance
  rgb, capture sharpening (with *measure for this photo*), a black & white
  section (a second color calibration with a gray mix, film looks and a
  color filter wheel previewed as you hover), tags and export. *Pipeline*:
  the edit's modules in pipe order, on/off, drag to reorder, each with its
  settings. Pinned under it: the history step (click: the whole history,
  compress), undo/redo, save (it shows when a save is needed; leaving with
  unsaved changes asks), discard, ⋯ for export, duplicate and start over.
- **Tools** (one at a time, its controls in a bar under the toolbar):
  - *crop & rotate*: turn, mirror, straighten (with darktable's automatic
    crop) and a crop box over the whole photo, optionally held to an
    aspect ratio, with thirds, grid or golden ratio guides; edits
    darktable's own flip, ashift and crop modules;
  - *dust*: the film roll's sensor dust found in this photo circled on it,
    *heal N*, or click a spot to heal it;
  - *erase*: draw around an object (or click a round spot) and an AI model
    fills it (`ai_fill`: LaMa on this computer, or Black Forest Labs' FLUX
    models online with your key), as a composite instance;
  - *sky / subject*: click an area, darktable's AI mask finds it, and it
    gets its own exposure, vibrance, contrast and saturation;
  - *markers*: name points and areas ("left tree") so an AI assistant can
    refer to them;
  - zoom (*fit*, *100%*, *200%*, double-click; drag to pan, the engine
    renders the region shown), *clipping* (O), *before / after* (a wipe, or
    side by side when the crop changed).
- **Working with an AI:** *AI assistant* in the header (green while one is
  connected) gives the MCP config for this app's engine and library
  (Claude Desktop, Cursor, VS Code, Codex, ...) and Claude Code's
  `claude mcp add` with the skills. The assistant's edits show up live;
  its comparisons (`compare_before_after`) and alternatives
  (`propose_alternatives`: crops, B&W filters, looks, shown as a strip to
  pick from) appear here.
- **Export:** darktable's export of the saved edit (format, longest side,
  quality; darktable's export settings for the rest, by default into
  `$(FILE_FOLDER)/darktable_exported/`), a download link, a zip for
  several photos; unsaved changes are saved first, after asking.
- **Sharing the library with darktable:** darktable and the engine can't
  have one library open at the same time. darktable's window from the same
  fork serves the library itself (see below). For a darktable started
  without it, the header releases the library to it, and has *take back*
  and *quit darktable and take back* (asks darktable to quit the normal
  way; never kills it).

Features that need the `darktable-api` branch (AI fill, AI masks,
markers) are greyed out on an engine without them.

Measured on an Apple M1 (CPU only) with a 20 MP raw: a preview after a slider
change takes 0.15–0.4 s at 1200 px; the first preview of a photo about 0.5 s.

## Requirements

The setup for all three repositories, tested on clean macOS and Ubuntu
machines each week: darktable-api-mcp's
[Quick start](https://github.com/mmcc-xx/darktable-api-mcp#quick-start-engine-mcp-server-and-web-app).
In short:

1. **darktable-api**, built from the fork's `darktable-api` branch with
   `-DUSE_API=ON` (and `-DUSE_AI=ON` for AI fill and masks); the frozen
   `darktable-api-5.6` branch lacks most of this app's tools. Open the
   library copy only with the `darktable` from the same build (its edits
   use module versions an older darktable can't open). To update:
   `git pull --recurse-submodules`, `cmake --build build`, restart the app.
2. Python 3.10 or later.
3. [darktable-api-mcp](https://github.com/mmcc-xx/darktable-api-mcp): the
   app's engine client (`dtweb/engine.py`) is its client, imported from this
   Python if installed there, else from its checkout (the one `DTAPI_MCP`
   runs from, else `~/darktable-api-mcp`). With its dust extras
   (`pip install 'darktable-api-mcp[dust]'`) it also gives dust finding and
   healing, AI fill, sensor clipping and panoramas, which the app runs in
   `dtweb/mcp_worker.py` under darktable-api-mcp's own Python (found via
   `DTAPI_MCP` or `DTAPI_MCP_PYTHON`), not its own.

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
| `DTAPI_MCP` | `darktable-api-mcp` on the PATH, else `~/darktable-api-mcp/.venv/bin/darktable-api-mcp` | the MCP server the *AI assistant* dialog's config runs |
| `DTAPI_MCP_PYTHON` | `python` next to `DTAPI_MCP` | the Python that runs `dtweb/mcp_worker.py` (dust, AI fill, clipping, panoramas); it needs darktable-api-mcp's packages |
| `DTAPI_CLIP_DIR` | `~/.cache/darktable-api-web/clip` | cached sensor clipping overlays |
| `DTAPI_VARIANTS_DIR` | `~/.cache/darktable-api-mcp/variants` | where an AI's alternatives (propose_alternatives) are rendered; must match the MCP server's |
| `DTWEB_BACKLOG_DIR` | this project's author's backlog folder | the backlog page's folder (QUEUE.md, FEATURES.md, BUGS.md, DONE.md) |
| `DTWEB_PANORAMA_DIR` | beside the first frame | where *panorama…* writes the stitched TIFF |
| `DTAPI_GUI_BIN` | `darktable` next to `DTAPI_BIN` | the only darktable *quit darktable and take back* may quit |

**No authentication.** Anyone who can reach the app can browse this
computer's folders (the import dialog) and add files to it. Keep it on 127.0.0.1, or put it behind something that
authenticates, before exposing it to a network.

## Backlog page

`/backlog` (the *backlog* link in the header) shows the darktable-api backlog:
the night queue, FEATURES.md, BUGS.md, the finished items, the latest night
run note and the forecast. Tables sort by clicking a header. Features and bugs
can be edited, added and queued, and queue items moved or unqueued. It needs
no engine. The folder is `DTWEB_BACKLOG_DIR` (default
`/Users/clark/darktableluamcp/darktable-api`); each change rewrites the one
Markdown file there (atomically, one writer at a time, refused while
`launchd/.daily-run.lock` exists) and makes a git commit of just that file in
the folder's repo. Nothing is pushed.

## Layout

| | |
|---|---|
| `dtweb/engine.py` | connects to the darktable-api engine (starting it if needed) and talks JSON-RPC to it: edits before thumbnails, latest preview wins, events from other apps, the library hand-off |
| `dtweb/main.py` | FastAPI routes: library, thumbnails (cached by edit state), ratings/labels, photo editing, live updates (server-sent events), library hand-off |
| `dtweb/templates`, `dtweb/static` | pages (plain HTML and JavaScript, no framework) |
| `dtweb/static/meta.js` | the title, description and tags editor (library and darkroom) |
| `dtweb/mcp_worker.py` | runs darktable-api-mcp's functions (dust, AI fill, clipping, panoramas) for the app, under the MCP's Python, on the same engine |
| `dtweb/backlog.py` | the backlog page: parses and rewrites the Markdown backlog files, commits each change |
| `make_library_copy.py` | makes the library copy |

Tested on macOS (desktop and phone browsers); the Quick start's weekly
run also starts it on Ubuntu 24.04. On Linux, *quit darktable and take back* uses darktable's
D-Bus `Quit` method (untested).

## License

GPL-3.0, like darktable.
