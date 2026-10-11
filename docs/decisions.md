# Decisions

What was decided, by whom, and why. Newest first within each section. When a
decision is reversed, leave the old entry and add the new one beside it with
the evidence.

## Stack

### The core player (ATA-109, 2026-10-11)

- **The playlist is NTS 1 and NTS 2.** On launch NTS 1 plays, whatever was
  playing at exit. Next and previous switch channels and wrap around; while
  stopped or paused they select the channel without playing it.
- **Pause drops the connection, as stop does.** Resuming a paused live
  stream would play from minutes ago, so Play after a pause reloads it.
  Play while playing does nothing. If WebView2 refuses autoplay, the player
  goes to `stopped` and waits for Play rather than retrying.
- **Reconnect** (`player.ts`): an `error`, an `ended`, or a clock that has
  not moved for 10 s while playing reloads the same channel after 1, 2, 4,
  then every 8 s, until it plays again; a moving clock resets the backoff.
  Pause and stop cancel a pending retry. Checked on a release build through
  `tools/proxy.mjs`: a 30 s cut on NTS 1 showed `reconnecting` within 3 s
  (the buffer played out first), six retries all to `/nts1`, and playback
  5 s after the cut ended. A pause during a cut stayed paused: no tunnel
  opened after the cut ended.
- **Remembered:** volume, mute, balance and the EQ, in the trusted page's
  `localStorage`, clamped on load. The skin came later, with ATA-112: a
  skin picked in the picker is remembered, and with none picked every
  launch wears a random one (Mika decided this for Ata on 2026-10-11; see
  Skins below).

### Skin code runs in its own webview, with no capabilities (ATA-107, 2026-10-11)

**The host.** The main window holds two webviews. `main` is the trusted
page: it owns the `<audio>` element, the Web Audio graph (gain, stereo
panner, a 10-band EQ, the analyser) and, later, reconnect. `skin` is a child
webview drawn over it, loaded from our own `skin` protocol
(`http://skin.localhost` on Windows). The skin engine and every skin script
run there and nowhere else.

**Why this host and not a sandboxed frame.** Both were attacked with the
ATA-103 attempts (`tools/escape.mjs`, Tauri 2.12.3). Tauri injects
`__TAURI_INTERNALS__`, `window.ipc` and the invoke key into both. First,
before the skin protocol sent a CSP (dev build):

| Attempt, from skin code | Skin webview | Sandboxed srcdoc frame | Trusted page (control) |
|---|---|---|---|
| Read the parent | no parent to read | `SecurityError` | n/a |
| Replay a captured IPC request, no key | `missing Tauri-Invoke-Key header` | same | n/a |
| Replay it with the key | `window.set_size not allowed on window "main", webview "skin", URL: local` | `Origin header is not a valid URL` | 200, window resized |
| `__TAURI_INTERNALS__.invoke` (`set_size`, `app version`, our `skin_send`) | not allowed, same message | `Origin header is not a valid URL` | resolves, window resized |
| Force the `postMessage` fallback | not allowed, same message | no reply | resolves, window resized |
| Raw `window.ipc.postMessage` with the key | no effect | no effect | window resized |
| Navigate to the app's page / `window.open` it | stays on `skin.localhost` / `null` | `null` | n/a |

The frame is cut off only because Tauri rejects `Origin: null` and WebView2
does not pass a sub-frame's `postMessage` on. The skin webview is refused by
the ACL, by webview label, even though Tauri counts its origin as **local**
("URL: local" above). So the boundary would hold if Tauri's origin rules
changed.

Then with the CSP below, on a dev and a release build, each run on a hidden
desktop with `tools/hidden-run.ps1`. The IPC rows now call `skin_send` with
a title unique to the row, and "reached" means that title arrived in the
skin webview. The trusted page no longer has `set_size`.

| Attempt, from the skin webview | Release build | Trusted page (control) |
|---|---|---|
| Replay a captured IPC request, with or without the key | `Failed to fetch`: the CSP's `connect-src` stops it before Tauri sees it | 200, reached |
| `__TAURI_INTERNALS__.invoke` `skin_send`, `set_size`, `app version` (it falls back to `postMessage`) | `Command … not allowed by ACL`, not reached | resolves, reached |
| Force the `postMessage` fallback | `Command skin_send not allowed by ACL`, not reached | resolves, reached |
| Raw `window.ipc.postMessage` with the key | not reached | reached |
| Read the app's page (`fetch` of `http://tauri.localhost/`) | `TypeError` (CSP) | n/a |
| `fetch` a remote URL, `no-cors` | CSP `connect-src` violation | n/a |
| Frame a remote page / the app's page | CSP `frame-src` violation | n/a |
| Navigate to the app's page / `window.open` it | stays on `skin.localhost` / `null` | n/a |

The dev build gave the same rows, with Tauri's longer "not allowed on window
"main", webview "skin"" wording. Before the CSP, a release build's skin
could read the app page (315 bytes) and frame it, and a dev build's skin
could read the Vite dev server; both are now CSP violations.

What the boundary rests on:

- `capabilities/default.json` names `webviews: ["main"]`, never a window. A
  capability matched by window would also cover the skin webview, which is a
  child of the main window.
- `build.rs` declares an app manifest. Without one, Tauri skips the ACL for
  app commands called from a local page (`webview/mod.rs` in Tauri 2.12.3),
  and the skin webview counts as local. Every new command goes into that
  manifest and a capability.
- Everything the skin protocol serves carries a CSP: `default-src 'self'`;
  scripts from `'self'`, inline and eval (skins need `jscript:`); images from
  `'self'`, `data:` and `blob:`; no frames, objects or forms. Skins need no
  network: the trusted page fetches what they show.
- The skin webview refuses to navigate off `skin.localhost` and to open
  windows (`on_navigation`, `on_new_window` in `lib.rs`).
- `Window::add_child` sits behind Tauri's `unstable` feature, outside
  semver, so `Cargo.toml` pins `tauri` to `~2.12.3`. Re-run
  `tools/escape.mjs` on every Tauri upgrade.

A skin webview also has a real origin, so `localStorage` works and its
scripts load from the protocol without the CORS problem of an opaque frame.

**The protocol.** Skin to host is a `POST /msg` on the skin protocol with a
JSON body. Rust parses it into a fixed enum and refuses anything else (400),
unknown fields included, and refuses requests from any webview but `skin`
(403):

| Message | Handled by |
|---|---|
| `{ "type": "play" }`, `{ "type": "pause" }`, `{ "type": "stop" }` | the trusted page |
| `{ "type": "next" }`, `{ "type": "previous" }` | the trusted page: the other channel, wrapping around |
| `{ "type": "mute", "value": true \| false }` | the trusted page |
| `{ "type": "volume", "value": 0..1 }`, `{ "type": "balance", "value": -1..1 }` | the trusted page, clamped |
| `{ "type": "eq", "band": 0..9, "gain": -15..15 }` | the trusted page, clamped |
| `{ "type": "seek", "seconds": n }` | accepted, ignored: live streams cannot seek |
| `{ "type": "drag" }` | Rust: moves the window with the pointer, only while our window is in front and under the pointer with the button down |
| `{ "type": "shape", "width", "height", "rects": [[x, y, w, h], …] }` | Rust: sizes the window and sets its region. Ignored unless the view is 1–4096 px a side and every run is non-empty and inside it, with at most ceil(width / 2) runs per row |
| `{ "type": "close" }`, `{ "type": "minimize" }` | Rust: closes or minimizes the window (ATA-110) |
| `{ "type": "launchUrl", "url": "…" }` | Rust: opens the URL in the default browser, only if it parses as http(s), is at most 2048 characters, and comes 3 s or more after the last one (ATA-110) |

Host to skin: the trusted page calls the `skin_send` command, and Rust
dispatches a `message` event in the skin webview. Today that is, four times
a second (ATA-109):

    { "type": "state", "playState", "channel", "title", "time", "duration",
      "volume", "mute", "balance", "eq", "level" }

`playState` is `playing`, `buffering`, `reconnecting`, `paused` or
`stopped`. `duration` is 0 for a live stream, as in WMP: a skin shows its
seek bar disabled. `volume`, `mute`, `balance` and `eq` (ten gains in dB)
are the saved settings, so a skin's controls start where the listener left
them. The skin also gets `GET /` (the engine page), `GET /engine.js` (the
engine) and `GET /skin.wmz` (the skin itself, whole) from the protocol, and
nothing of the app's. Until ATA-108 the stub skin read its files one by one
from `GET /files/<name>`.

**Window shape.** The skin computes its opaque runs from the view's
`transparencyColor` and sends them; Rust combines them with
`SetWindowRgn`, and again when the window moves to a monitor with another
scale. On bluegrid, the region Windows reports cuts exactly the 19,200
`#FF00FF` pixels of `background.bmp`. The rescale has not been tried on two
monitors.

**Dragging.** `start_dragging` returned Ok but did not move the window: the
skin webview holds the mouse capture. Rust instead follows the cursor while
the primary button is down. The button state is system-wide, so the drag
starts only while our window is in front and under the pointer; otherwise a
skin could make the window follow a drag in another app. Not yet seen
working with a real mouse.

**Audio.** NTS 1 played and stopped from the stub skin's buttons, with the
clock running, and again on the release build with the CSP (volume at 0).
NTS 1 was on dead air during the test (a decoded sample
peaked at 0.00002), so the graph was checked on NTS 2: level 0.27 at full
volume, 0.03 at 10%.

### Bootstrap: identity, toolchain, shared code (ATA-106, 2026-10-10)

- **Identity:** product name "NTS Radio Bootleg Media Player", identifier
  `com.datatuna.ntswmp`, executable `nts-desktop-wmp.exe`. Each differs from
  the Winamp app's, so the two install into different folders, keep separate
  settings and WebView2 profiles, and run at the same time. Checked on
  2026-10-10 with a debug build: `tauri dev` of this app opened beside an
  installed Winamp app 0.1.2, both windows up at once. Two installed copies
  side by side were not tried, since this app has no installer release yet.
- **Dev port 1430**, not the Winamp app's 1420, so both repositories can run
  `tauri dev` together.
- **The toolchain is the Winamp app's:** Vite, TypeScript, oxlint,
  `node --test`, `npm run check`, and the same CI job on `windows-latest`.
- **NTS code is copied, not shared.** `live.ts` and the parsing half of
  `mixtapes.ts` come from the Winamp repo's PR #9 (`6379c0e`, not merged
  yet); the parsing half of `picks.ts` comes from its `main` (`bdc0f10`).
  Their tests and fixtures came along. A shared package is not worth it for
  two apps yet.
- **Left for later issues:** a single-instance lock, the updater and release
  workflow, a CSP, and an icon of its own.

### Shell: Tauri 2 (proposed by Lama, confirmed by Ata, 2026-10-10)

The same shell as the Winamp app, for the same reason: it reuses the system
WebView, so the app stays light.

### A separate app with its own skin engine (Ata, 2026-10-10)

A separate app in its own repository, drawing WMP skins with its own engine
rather than through Webamp. WMP skins matter as much as the Winamp app does.

## Skins

### Skins from archive.org: the list, the launch, the picker (ATA-112, 2026-10-11)

- **The compatibility list.** `skins/compatible.json` holds all 216 `.wmz`
  files in the item, by path, md5 and size, each marked `works`, `partial`
  or `broken` with up to eight lines of what the engine logged. On
  2026-10-11: **59 work, 97 partial, 60 broken.** All 7 ATA-103 skins work.
  `tools/compat.mjs` builds it: it reads the item's metadata API, downloads
  each skin once into `%LOCALAPPDATA%\nts-wmp-compat` (3 s apart, a second
  try after 30 s), runs it through the engine in headless Edge with the
  stand-in host from `skin-preview.mjs`, and records:
  - **broken:** the engine could not load it, or it drew nothing. 54 of the
    60 open on a view that only hands over to the player in a later view: a
    `previewView` for WMP's skin chooser (30), or a `mediaSwitcherView` or
    `versionView` that picks the player's view by media type or WMP version
    (24). The engine draws only the first view (AGENTS.md, Known gaps).
  - **partial:** it drew, but a script failed, an image was missing or
    would not decode, an element is unknown, it has no play or no stop
    control, or more than 20 pixels of `#FF00FF` are left on the canvas
    (43 skins: a transparency the engine did not cut, which would show as
    pink in the window).
  - **works:** none of that. Video, item playlists and popups that are not
    drawn do not count against a skin: a radio has no video.
  The checks miss a skin that draws but looks wrong. A sample of the
  screenshots was looked over; Kwanzaa, for one, is all visualiser and
  shows black candles until ATA-114.
- **On launch** (`skins.rs`): the skin picked in the picker, or else a
  random `works` skin. It comes from the cache
  (`%LOCALAPPDATA%\com.datatuna.ntswmp\skins\<md5>.wmz`), checked against
  its md5, or is downloaded through Rust (archive.org sends no CORS
  headers), checked, and cached. At most one download per launch; one more
  try after a second, since archive.org now and then answers 500 for a file
  it serves a second later. The first paint waits up to 8 s for it, then
  settles for the house skin while the download finishes into the cache.
  A skin that fails to download, fails its md5, or that the engine cannot
  load gives the house skin. The cache keeps 100 MB, oldest out first, as
  the Winamp app's does.
- **TLS:** `ureq` with the system's TLS (SChannel on Windows). Its
  `native-tls-no-default` feature panics on every https request (ureq 3.4.2
  checks for the `native-tls` feature), so the dependency uses
  `native-tls`, which also carries a bundle of root certificates the app
  does not use. The installer is 1.34 MiB, the exe 3.6 MiB.
- **The picker** opens on a right click on the skin, as WMP's menu offered
  its skin chooser. It is a window of our own (`picker.html`), with a
  capability for three commands: `list_skins`, `choose_skin`, and
  `open_link`, which opens only archive.org `/details/` pages and
  `https://www.nts.live/supporters`. It lists the working skins with their
  publisher folder and a link to each skin's archive.org page, notes the
  download size of those not cached, and credits the archive and links to
  NTS's supporters page. archive.org has no preview per skin, so the
  picker shows none; picking one puts it on the window.
- **Remembering the choice** (Mika for Ata, 2026-10-11, carried over from
  ATA-109): a skin picked in the picker opens on every launch and downloads
  nothing. "A random skin on every launch" in the picker forgets the
  choice. If the picked skin fails to load, the house skin shows and the
  choice stays. It is kept in `skin.json` beside the cache, in Rust, since
  Rust serves the skin before the trusted page has loaded.

Checked on a release build on a hidden desktop, with `--mute-audio`,
timing from process start to the skin's first canvas:
- **Ten launches in a row**, from an empty cache, wore ten different skins
  and all played NTS 1. Each downloaded its skin and drew in 2.5 to 4.2 s;
  a launch on a cached skin draws in 1.1 s. An earlier run of ten, before
  the retry, wore nine (claw twice; that launch took 1.1 s, from the cache).
- **archive.org blocked** (the webview with `--host-resolver-rules="MAP
  archive.org ~NOTFOUND, MAP *.archive.org ~NOTFOUND"`; Rust ignores
  Chromium's flags, so its downloads went to a dead `HTTPS_PROXY`) with an
  empty cache: the house skin, playing, in 6.0 s with the connection
  refused (two tries), and in 9.7 s with it hanging (the 8 s wait; before
  the retry).
- **The picker** opened from a right click, listed 59 skins, and put the
  pick on the window (Kenwood_MPXP, then Television). Relaunches wore it
  again in 1.1 to 1.3 s with no download. With Kenwood_MPXP removed from
  the cache and the network blocked, the house skin showed and `skin.json`
  still named it. "A random skin on every launch" set `{"skin":null}` and
  the next launches were random again.
- Not tried: a real right click with a real mouse (the input came through
  DevTools), and the picker's links, which open the default browser.

### The script runtime and the WMP object model (ATA-110, 2026-10-11)

Skins now run their scripts. Written from Microsoft's reference and from
what the 7 ATA-103 skins call; no code from Webamp Modern.

- **Where scripts run.** In the skin webview, as before, which no capability
  names. Each file a view's `scriptFile` lists runs as global code (indirect
  `eval`) inside `with (__wmpScope)`. The scope holds element ids, then
  `player`, `theme`, `mediacenter` and the `ps*`/`os*` constants; anything
  else falls through to the global object, where the skin's own functions
  and variables live. Handlers and `jscript:` attributes run inside a second
  `with`, for the element's own members (`value`, `down`, `left`). Inside the
  `with` block a function becomes global only when its declaration is
  reached, where JScript hoists them all, so each file starts by copying
  its top-level functions to the global object: a statement that throws
  loses nothing declared below it. A script that fails is logged, and its
  literal constants are kept so the layout still works (ATA-108's fallback).
- **Objects.** `runtime.ts`. WMP's objects are COM objects, so members are
  case-insensitive (`player.PlayState`). They read the host's state message
  and send its messages: `player.controls` (play, pause, stop, next,
  previous), `player.settings` (volume, balance, mute, set locally at once so
  bindings follow before the host replies), `currentMedia` (the channel's
  title, `getItemInfo("title")`, `"Type"` is `broadcast`), `currentPlaylist`
  (NTS 1 and NTS 2, so circle's track number reads 001 or 002), the
  equalizer's ten `gainLevel`s, `theme.loadPreference`/`savePreference`
  (per skin, in `localStorage`; an unsaved one reads `"--"`, booleans save as
  `"True"`/`"False"` as JScript wrote them), and `player.launchURL`, which
  sends only while a click or double-click is being handled, so a skin's
  timer or `onLoad` cannot open tabs on its own. What a
  radio cannot do returns a safe default: no video (`imageSourceWidth` 0), no
  DVD, no library, no scanning, no presets. Unknown members are logged once
  and read as undefined.
- **Play and open states.** `playing` is psPlaying, `buffering` psBuffering,
  `reconnecting` psReconnecting, `paused` psPaused, `stopped` psStopped. The
  open state is osMediaOpen once the host names a channel; a channel switch
  passes through osMediaChanging. `<player>` fires its `*_onchange` and
  `playStateChange(NewState)`/`openStateChange(NewState)` handlers, open
  state first.
- **Handlers.** `onLoad` (after the scripts, before the first paint),
  `onTimer` with `timerInterval`, `onClick`, `onDblClick`, `onMouseDown`,
  `onMouseOver`/`onMouseOut`, `value_onchange` and `onDragEnd` on sliders,
  `onEndMove` after `moveTo`, `onClose` when the skin closes the window, and
  `<property>_onchange` whenever a script sets that property. A sticky
  button's `down` flips before its `onClick` reads it; one whose `down` is
  bound (`wmpprop:player.settings.mute`) goes back to the binding after. A
  named transport button still does its own job and then runs its
  `onClick`; a mute button with an `onClick` mutes through it.
- **Bindings and expressions.** `wmpprop:` reads the object model or another
  element (`wmpprop:bgTransports.left`); `wmpenabled:`/`wmpdisabled:` follow
  the transport. Both, and `jscript:`, are worked out again after every
  change, so they follow the player and whatever scripts set. A property a
  script sets wins over the markup.
- **Resizing.** A script can resize the view (Classic shrinks to 176 px tall
  while audio plays, as WMP does). Plain numbers then move and stretch by
  `horizontalAlignment`/`verticalAlignment` (`right`, `bottom`, `center`,
  `stretch`), by how far the parent has grown since load; `jscript:`
  geometry is worked out again instead, so the two never add up. An element
  centred with no position of its own sits in the middle of its parent
  (Classic's logo). The skin sends a new `shape` whenever its shape changes.
- **wmploc.dll.** Our own stand-ins, never Microsoft's: `RT_TEXT/#132` is an
  empty script, since none of the 7 skins calls a function it defines (the
  `next()`/`previous()` ATA-103 counted are the effects element's own
  methods); `RT_STRING/#2063` is "Disconnected" and the other ids read empty,
  so 9SeriesDefault's format strings fall back to the bare value; three 9×9
  glyphs stand in for the `RT_IMAGE` status icons (playing, paused,
  stopped).
- **Painting, revised against the previews.** Three things ATA-108 drew from
  markup alone turned out wrong once scripts showed more of each skin:
  - A container's `backgroundColor` lies under everything it holds and shows
    through its background's `transparencyColor` (bluegrid's black screen).
    With a `clippingColor` and no `backgroundColor`, that colour is black:
    circle's digit slots are black, with the digits cut out of the window.
    The colour fills only the subview's own region, not its clipped corners:
    the house skin's dial sits on the body's ring, which shows round it.
  - Children with a negative `zIndex` are drawn on the parent's surface, not
    clipped to their subview: Asimov_Radio's head hangs 160 px below the
    radio subview that holds it.
  - `clippingColor` cuts the subview's background and its plain children
    (circle's arrow buttons carry the colour), but not child subviews, which
    have regions of their own (circle's digits), and not what lies beneath
    (Asimov_Radio's head runs on under the radio, as its preview shows).
    anemone's rectangular visualiser stays inside the ring because
    visualisers are not part of the window shape.
- **Repeated attributes: the last one wins** (reversing ATA-108's "the first
  wins"). circle's `durationText` has `top="11" … top="63"` and its preview
  draws it at 63; cerulean's screens repeat `left`/`top`, and only the last
  values put them where its script expects (`top` 0 is its `scrUp`).

Checked on the 7 skins in the preview tool and on a release build on a
hidden desktop (`--mute-audio`, the level read from the host's state):
each opens on the pane its preview shows, shows "NTS 1" and the elapsed
time where it has a place for them, and plays, stops and changes the volume
through its own controls. anemone's and cerulean's volume live on panes
their scripts open (anemone widens to 635 px; cerulean slides its screen up
with `moveTo`), and were reached through those. `tools/escape.mjs` gives the
same result as ATA-107.

Close and minimize now have messages; the house skin (ATA-111, below) has
neither button yet.

### The house skin: Bootleg House (ATA-111, 2026-10-11)

The one skin that ships, drawn for this project. It is what the app shows
until the skin cache (ATA-112) has something better, and the skin the engine
can always be tested on. It needs no network: `house.wmz` is built into the
binary, and Rust serves it whenever `NTS_WMP_SKIN` is unset or unreadable.
On a release build behind `tools/proxy.mjs`, the app drew it and played
NTS 1, and the only hosts it reached were `streams.radiomast.io`, the
radiomast edge, and WebView2's own `config.edge.skype.com`, which `main`
reaches too.

**The design.** A table radio drawn the way WMP 7 to 9 skins were drawn:
- **A dial on the left**, a slate disc with a brushed-metal ring and tick
  marks, holds the visualiser in a round window under a glass highlight.
  The disc hangs off the end of a capsule, so the window is not a rectangle.
- **An amber display**, like a backlit radio's, holds the title (scrolling
  when it is long) over the status and the clock. Amber reads as a radio
  and stays away from NTS's own black and white.
- **The controls are metal beads in sockets.** Play and pause are one amber
  bead in one place: the skin shows whichever the player can do now
  (`visible="wmpenabled:player.controls.play"`), as WMP's own skins do.
  Previous, stop, next and mute are a button group with a mapping image.
  Hover tints the icon amber; pressed beads light from below and their icon
  drops a pixel; muted shows a crossed speaker.
- **The playlist drawer** under the capsule lists the two channels, the
  current one in amber. A click on the other row switches to it.
- No NTS logo and no wordmark: the only "NTS" on the skin is the channel
  name the player reports.

It uses most of the element kinds the engine draws: subviews with a
`clippingColor` and a `transparencyColor`, `alphaBlend`, a button group
with hover, down and disabled images, buttons bound with `wmpenabled:`,
text bound with `wmpprop:` (with scrolling), a slider with a fill and thumb
states, an `effects` area and a `playlist`; not a progress bar or a custom
slider. It has no close or minimize button, since the skin protocol has
no message for them yet.

**The sources.** Layered SVGs in `skins/house/art/`, one Inkscape layer per
state, rendered by `build.mjs` with resvg (`@resvg/resvg-js`, a dev
dependency under MPL-2.0 that never ships) into 24-bit BMPs, then zipped
with fixed timestamps so the same sources give the same bytes. The
silhouette and anything touching the key colour are drawn with crisp edges,
and everything else sits at least 1.5 px inside them, so smoothing never
blends into `#FF00FF`. A test rebuilds the skin and compares it with the
committed `house.wmz`.

**The engine draws `<playlist>` now.** Only for this one case: its rows are
the player's channels (`CHANNELS` in `player.ts`), in `foregroundColor`,
with the current one in `itemPlayingColor` on
`itemPlayingBackgroundColor`. A click on a row sends `next` as many times
as it takes to reach that channel, so no new message was needed. Like text,
the playlist is drawn inside the window shape and does not add to it.

### The engine: one canvas, static first (ATA-108, 2026-10-11)

Written for this project, reading Microsoft's skin reference and checking
against the 7 ATA-103 skins; no code from Webamp Modern.

- **Load.** The skin page fetches the whole `.wmz` and unzips it with the
  platform's `DecompressionStream`, so Rust only serves bytes and no zip
  library ships. File names are looked up lower-cased.
- **Parse.** A forgiving tokenizer, not `DOMParser`: real skins repeat
  attributes (the first wins; reversed in ATA-110), put raw `&&` and `<` in script attributes, and
  close `<buttonGroup>` with `</buttongroup>`.
- **Paint.** Everything is painted back to front on one canvas the size of
  the view. A subview is drawn on its own layer: children with a negative
  `zIndex`, then its background with its `transparencyColor` (and
  `clippingColor`) cut out, then the other children, then its
  `clippingColor` cuts the whole layer. Negative `zIndex` behind the
  parent's background is how cerulean's visualiser shows through the
  magenta hole in its face.
- **Window shape.** The opaque pixels of the skin's images. Visualisation
  areas and text are drawn inside that shape but do not add to it, or
  anemone's rectangular visualiser would square off its outline. On each of
  the six target skins, the region Windows reports has exactly as many
  pixels as the canvas has opaque ones (anemone 54,764; bluegrid 33,480;
  cerulean 52,570; circle 10,600; Asimov_Radio 119,564; 9SeriesDefault
  115,213).
- **Expressions.** `jscript:` attributes made only of element properties
  (`jscript:svTopMiddle.left+svTopMiddle.width;`, with the element's own
  properties in scope too) are evaluated in the skin webview, where skin
  code may run anyway. So are literal constants a skin's scripts declare at
  the top level (`var leftOffset = 260;`), which Asimov_Radio lays out with;
  reading a literal runs none of the script. Anything else is logged and
  skipped until the script runtime (ATA-110).
- **Player state.** The named controls follow the host's state message
  (ATA-109): Play is enabled unless a stream is on (playing, buffering or
  reconnecting), Pause and Stop only while one is; Previous and Next always
  (they switch channels); fast forward, rewind and seek sliders never, since
  a live stream has no length. Each sends its own message, and Mute sends
  the opposite of the host's mute. Sliders bound to the volume or balance,
  named or not, start at the host's saved values and send `volume` and
  `balance`, scaled from the slider's own range; EQ sliders show the saved
  gains. A button whose `down` is bound to `player.settings.mute`
  (9SeriesDefault's) is a mute button, and draws pressed only while the
  host is muted. The elapsed time is blank while stopped, as in WMP, and
  while paused, because pausing drops the stream and its clock reads 0.

### Source: archive.org, one per launch, a compatibility list (proposed by Lama, confirmed by Ata, 2026-10-10)

- `.wmz` files come at runtime from the archive.org item
  `windowsmediaplayerskinsarchive` (216 skins), one per launch, cached
  locally.
- The app picks only from a compatibility list kept in this repository: skin
  names and checksums, never the skins.
- **A house skin ships with the app:** an original skin drawn for this
  project. It is the fallback when archive.org is down or a skin fails, and
  the engine's test fixture.

## Research

### WMP skins through Webamp Modern's engine (ATA-103, 2026-10-10)

The spike ran Webamp Modern's experimental WMP engine on 7 real skins
(Classic, bluegrid, circle, cerulean, anemone, Asimov_Radio, 9SeriesDefault).
The full report, with screenshots, is on ATA-103; the spike code is draft PR
#14 in nts-desktop-winamp.

- **Format:** a `.wmz` is a zip holding one `.wms` XML file, 27 to 115 BMPs
  and 1 to 3 JScript files. The `.wms` is UTF-16 with a BOM, or
  Windows-1252, and its tag names are case-insensitive
  (`<buttonGroup>…</buttongroup>`).
- **What skins need:** `view` and `subview` layout; `button`, and
  `buttongroup` with colour-mapped hit areas; sliders, text, `effects`
  visualisers; `clippingColor` window shapes; `jscript:` expressions in
  attributes (Classic is sized entirely by them); `wmpprop:` and
  `wmpenabled:` bindings that follow the player's state; and the WMP object
  model for scripts. Each skin uses 16 to 41 members of `player.*`,
  `theme.*`, `view.*`, `eq.*`, `pl.*` and `mediacenter.*`, plus the `ps*` and
  `os*` constants.
- **`wmploc.dll`:** every test skin references `res://wmploc.dll/RT_TEXT/#132`,
  WMP's shared script, but calls only 0 or 1 functions it does not define
  itself. Some use `RT_STRING` strings or an `RT_IMAGE`. We write stand-ins
  from what skins call, since Microsoft's resources cannot be shipped.
- **Webamp Modern's engine** (MIT, by x2nie, unchanged since 2023) drew 1 of
  7 skins correctly, and none was fully usable. It is a reference to read,
  not a base to build on.
- **Isolation:** in a `sandbox="allow-scripts"` frame, skin scripts could not
  reach Tauri. But Tauri injects `__TAURI_INTERNALS__`, `window.ipc` and the
  invoke key into sub-frames too; the frame is cut off only because Tauri
  rejects `Origin: null` and WebView2 does not pass a sub-frame's
  `postMessage` to Tauri. Prefer a webview with no capabilities at all.
- **Release builds:** Tauri's asset protocol sends no CORS headers, so an
  opaque-origin frame cannot load module scripts from the app. Inline the
  code, or use another protocol.
- **Audio:** with Web Audio, the `<audio>` element needs
  `crossOrigin = "anonymous"`, or the stream plays as silence while the clock
  runs.
- **archive.org downloads send no CORS headers.** Fetch skins through Rust,
  as the Winamp app's skin cache does.

### Prior art (2026-10-10)

None of these renders `.wmz` skins; they recreate WMP's own window by hand.

- [rmellis/Windows-Media-Player-8-WebApp-Clone-Public](https://github.com/rmellis/Windows-Media-Player-8-WebApp-Clone-Public)
  (GPL-2.0): a WMP 8 window in vanilla JS with radio streams, a 10-band EQ
  and WMP-style visualisations. Ata pointed us to it. Read it for ideas; do
  not copy code into this MIT app.
- [WindowsSe7en/Windows-MediaPlayer-Clone](https://github.com/WindowsSe7en/Windows-MediaPlayer-Clone)
  (MIT): a WMP 12 "Legacy" look-alike.
- [Loading617/WMPlayerXP](https://github.com/Loading617/WMPlayerXP) (no
  licence, so all rights reserved): look, don't copy.
- Webamp Modern's WMP engine (MIT, x2nie): the only open `.wmz` renderer
  found. See above.

### Carried over from nts-desktop-winamp

Streams, now playing, mixtapes, picks and reconnect work as they do in the
Winamp app, whose `AGENTS.md` and `docs/decisions.md` have the history. The
rules themselves are in the Invariants section of [AGENTS.md](../AGENTS.md).
