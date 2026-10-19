# darktable-api-web

A small web app for browsing a [darktable](https://www.darktable.org/) library
and editing photos in the browser, phone included. The real work is done by
darktable itself: the app talks to **darktable-api**, a long-running headless
darktable built from darktable's own code, which renders previews, applies
edits and writes the history to the library exactly as darktable does.

**Experimental.** Use it on a copy of your library (the copy script below
does that). Saving writes darktable's history in the engine's module
versions, which an older darktable may not be able to read.

The app works with the current engine but lags behind it: many newer
engine features (drawn and AI masks, dust removal, AI denoise, styles,
alternatives, ...) are only reachable through
[darktable-api-mcp](https://github.com/mmcc-xx/darktable-api-mcp) for now.

Written with AI assistance (Claude), directed and reviewed by the repository
owner.

[Demo Video](https://www.youtube.com/watch?v=VDfZbxvvniY)

## What it does

- **Library:** film rolls, filters (film roll, rating, color label), a
  thumbnail grid with paging. A click shows a photo in the detail panel at
  the right (larger, rating and labels, camera and exposure, title,
  description, tags, *open in darkroom*, duplicate, export); double-click
  or Enter opens it. ⌘/Ctrl-click or a tile's box selects (shift: a range,
  ⌘/Ctrl+A: all shown, Esc: none); a bar over the grid then rates, labels,
  duplicates or exports the selection. Rate, reject and set color labels by
  click or keyboard (arrows, 0–5, R, F1–F5: the selection's, else the shown
  photo's); ⧉ or ⌘/Ctrl+D makes a duplicate (a virtual copy with the saved
  edit). Thumbnails come from darktable's
  own thumbnail cache, rendered with each photo's current edit.
- **Export:** one or many photos with one set of settings (format, longest
  side, quality, high quality) into darktable's export folder, and for
  several as one zip to download; photos with unsaved changes in the
  darkroom are left out until you choose to save them. In the darkroom,
  the export section or ⋯ exports the photo open there.
- **Photo (darkroom):** the photo with a toolbar above it (one tool at a
  time; the active tool's controls in a bar under the toolbar) and a panel
  at the right. At the panel's top, an RGB + luminance histogram of the
  preview (click: logarithmic / linear) with the clipped highlight and
  shadow shares, rgb levels' black, gray and white handles under it (with
  pickers: click *black*, *gray* or *white*, then the photo), then the
  camera, date, lens and exposure (shutter,
  aperture, ISO, focal length, bias). Live preview from darktable's pipeline with sliders for
  exposure, white balance (color calibration's illuminant as temperature
  and tint, and *pick a neutral spot*: click something gray in the photo), AgX (or sigmoid, for photos edited with it), the tone
  equalizer's nine bands (−8 EV to 0 EV) and color balance rgb in
  collapsible sections (basic, tone, color, export), each summing up its
  settings in one line when closed; module on/off. A black & white
  section: one checkbox adds a second color calibration instance with a
  gray mix (the first keeps the white balance), and a strip of looks
  (luminance, red/orange/yellow/green/blue filters, darktable's film
  presets) rendered on the current edit; a click applies one. *Other
  modules* lists the edit's modules no panel shows (lens correction, or
  local contrast and the like added by Claude or a preset), each with on/off
  and *ask Claude*, which copies a question about it. Pinned under the panel:
  the history step ("step 14 of 14: local contrast", click for the whole
  history), undo/redo, save, discard unsaved, and ⋯ for export,
  duplicate (with this edit, ⌘/Ctrl+D, or unedited) and start over from
  darktable's defaults (your workflow and auto-apply presets).
  Previous/next within the current filter.
- **Crop & rotate:** turn by 90°, mirror, straighten by an angle (darktable's
  rotate and perspective module, with its automatic crop so no blank
  corners show), and crop: the *crop & rotate* tool shows the whole photo
  with a box to drag (edges and corners resize, inside moves; *done* or
  Enter applies, Esc cancels),
  optionally held to an aspect ratio (⤾ swaps portrait/landscape). These
  edit darktable's own flip, ashift and crop modules, so darktable shows
  the same crop.
- **Zoom:** *fit*, *100%* (one photo pixel per screen pixel) and *200%*
  at the toolbar's right, or double-click the photo for 100% there (again:
  fit). Zoomed, drag to pan; the engine renders just the region shown, so
  edits, the clipping overlay and the pickers work on it, and the
  histogram counts the area shown.
- **Clipping:** *clipping* in the toolbar (or O) paints blown highlights
  (a channel at 255) red and crushed shadows (black) blue over the
  preview, counted from the preview in the browser.
- **Before/after:** *before / after* in the toolbar compares the edit with the
  original: a wipe with a line to drag over the photo, or side by side when
  the crop changed. An AI (darktable-api-mcp's `compare_before_after`) opens
  the same comparison from its own "before" step; `#compare=N` in the
  address opens one with step N.
- **Alternatives:** versions an AI rendered for you to choose from
  (`propose_alternatives`: crops, B&W filters, looks) show as a strip under
  the photo, not applied: click one to see it large, *apply* applies it as
  history steps, ✕ dismisses them. A page opened later still shows them.
- **Export:** darktable's own export of the saved edit (format, longest
  side, quality, high quality; darktable's export settings for anything left
  at its default, including the folder, by default
  `$(FILE_FOLDER)/darktable_exported/`), with a download link for the file.
  Unsaved changes are saved first, after asking.
- **Connect Claude:** *Claude* in the header shows how to let Claude Code
  edit this library: the `claude mcp add` command filled in with this
  app's engine and library (set `DTAPI_MCP` if `darktable-api-mcp` isn't
  on the PATH or in `~/darktable-api-mcp/.venv`), linking the editing
  skills, and a prompt to start with. Claude's edits show up here live.
- **Sharing the library with darktable:** darktable and the engine can't
  have one library open at the same time. The header has *release to
  darktable* (the engine closes the library; unsaved edits are kept), *take
  back*, and *quit darktable and take back* (asks darktable to quit the
  normal way, so it saves; never kills it).

Measured on an Apple M1 (CPU only) with a 20 MP raw: a preview after a slider
change takes 0.15–0.4 s at 1200 px; the first preview of a photo about 0.5 s.

## Requirements

1. **darktable-api**, from the darktable fork
   https://github.com/mmcc-xx/darktable (see `src/api/README.md` there). Build darktable as usual with the API
   enabled (`-DUSE_API=ON`, off by default), which builds `darktable-api`
   alongside:

   Which branch: the one matching the darktable you edit the library with
   (a newer darktable writes module versions an older one can't open):

   | Your darktable | Branch | What it is |
   |---|---|---|
   | 5.6.x (5.6.2 on) | `darktable-api-5.6` | darktable's 5.6 release with the API; darktable's point releases are merged in as they come out. Most people want this one |
   | built from master | `darktable-api` (the fork's default branch) | darktable's development version with the API; darktable master is merged in weekly once the tests pass. Its edits use module versions darktable 5.6 can't open |

       git clone -b darktable-api-5.6 --recurse-submodules https://github.com/mmcc-xx/darktable.git
       cd darktable
       cmake -B build -G Ninja -DUSE_API=ON
       cmake --build build

   darktable's README lists the build dependencies (on macOS:
   `brew bundle --file=.ci/Brewfile`). `darktable` (the GUI) from the same
   build is the one to open the library copy with.

   To update: `git pull --recurse-submodules` and the `cmake --build` line
   again, then restart the app. darktable's changes come in as merges, so
   a pull always works (a `darktable-api` clone made before 2026-10-13,
   when that branch was still rebased, needs one
   `git fetch origin && git reset --hard origin/darktable-api`).
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
| `DTAPI_MCP` | `darktable-api-mcp` on the PATH, else `~/darktable-api-mcp/.venv/bin/darktable-api-mcp` | the MCP server the *Claude* dialog's command runs |
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
