# Decisions

What was decided, by whom, and why. Newest first within each section. When a
decision is reversed, leave the old entry and add the new one beside it with
the evidence.

## Stack

### Windows behaviour: tray, single instance, window memory, media keys, credit (ATA-115, 2026-10-11)

- **Tray icon:** Play, Stop, NTS 1, NTS 2, the pick's credit while one
  plays, and Quit. A left click brings the player forward; the tooltip is
  the current title, cut to the 127 UTF-16 units Windows keeps. The menu
  ids reach `main.ts` as a `tray` event, as in the Winamp app.
- **One copy runs at a time** (`tauri-plugin-single-instance`, first in the
  builder). A second launch brings the first copy forward, unminimised, and
  exits before it creates a webview: plugins start in `Builder::build`,
  windows only later in `run`. The lock is named after the identifier, so
  the Winamp app keeps its own; checked with both running.
- **The position is remembered** (`tauri-plugin-window-state`, position
  only; the skin sets the size). It is restored in setup, and the window is
  pulled into its monitor's work area when any corner is off every
  monitor, at launch and whenever a skin changes the window's size (not on
  every shape message, so a window parked partly off screen stays put). `pull_on_screen`,
  `fully_visible` and `fit_into` come from the Winamp app (ATA-71).
- **A pick's credit belongs to the app.** While a pick plays and is not
  stopped, a `credit` webview (our `credit.html`, whose capability allows
  only `credit`, `credit_size` and `open_credit`) shows "<uploader> on
  SoundCloud ↗" over the skin's top-left corner, at 16 px, white on
  `#c43c00` (5.3:1). It measures
  itself, Rust sizes it and adds its rectangle to the window's shape, and a
  click opens the track's page, which Rust holds and accepts only as an
  `https://soundcloud.com/` URL. The tray lists the same credit. A webview
  of its own, because the skin webview runs the skin's code, which could
  hide or fake anything drawn there. It costs one renderer, about 23 MB
  private, only while a pick plays (389 MB against 366 MB without it,
  measured with a pick playing).
- **Pause and stop swap the stream for a silent clip** (reverses part of
  ATA-109's "pause drops the connection"). Removing the src destroys
  WebView2's media player, and with it the media session: after a pause
  from the media keys Windows listed no session, so Play could not reach the
  app. Keeping the stream paused kept the session but also its connection
  (Tirci Lama found the edge server still holding a stalled one after
  270 s), which would still count as a listener. So pause and stop load a
  6 s silent WAV built in memory (`silence()` in `player.ts`), play it for
  a moment and pause it: no network, and Play sets the stream's src afresh.
  Both halves matter: a clip that never plays, or one shorter than about
  5 s, is left out of the session, and Windows dropped the app as before.
  Checked through a proxy: the stream's connection closed within seconds
  of each pause and stop, and the session stayed, Paused. The media keys and the overlay already
  went through `navigator.mediaSession` handlers to `player.pause()`,
  `play()` and `stop()`, so a pause from them is the player's own: it
  stayed paused for 30 s, with no watchdog reload.
- **Launch exits explained.** Copies of the app built by different agents
  share one WebView2 profile, since the identifier names it. A copy whose
  browser arguments differ panics in setup with `0x800700AA` and exits with
  `0xC0000409`, seen in the event log as a BEX64 fault in
  `nts-desktop-wmp.exe`; copies with the same arguments share a browser
  process that dies with the first copy closed. AGENTS.md, Gotchas, has the
  testing rules that follow.

### Now playing, Infinite Mixtapes and NTS Picks (ATA-113, 2026-10-11)

- **One playlist:** NTS 1, NTS 2, then the Infinite Mixtapes, then the
  12 latest NTS Picks, appended once per launch when their APIs answer.
  Next and previous walk the whole list and wrap; a playlist row sends the
  new `select` message rather than a run of `next`s, which would reload a
  stream at every step. The app still opens on NTS 1.
- **Titles.** A channel's title is `NTS 1 - <show> - <location>`, the
  channel first as in the Winamp app (Ata, 2026-10-09). That is
  `player.currentMedia.name` and `getItemInfo("Title")`;
  `getItemInfo("Author")` is the show and `getItemInfo("Location")` its
  place. `live.ts` now keeps `show` and `location` apart for this, which the
  Winamp copy does not. The live API is polled from the trusted page with
  its per-minute query string; when it fails the titles are "NTS 1" and
  "NTS 2" and the stream plays on. Checked with `www.nts.live` unreachable
  (a dead proxy for everything but `*.radiomast.io`): titles fell back,
  only the two channels were listed, and the clock and level kept moving.
- **Mixtapes** are radiomast streams (`mixtapes.ts`) and play and reconnect
  exactly like the channels.
- **Picks** play through SoundCloud's widget in the trusted page
  (`widget.ts`, adapted from the Winamp app). SoundCloud's terms want the
  uploader and SoundCloud credited, with a link back: a pick's title starts
  `<uploader> on SoundCloud - `, so skins that cut long titles still show
  it, and that credit is also its Author. A double click on a text showing
  `currentMedia.name` (or its title or author item info), or on the pick's
  own playlist row, opens the track page through `launchUrl`. A double
  click, not a press, so pressing the title still drags the window. A pick that does not start within 15 s, or that the
  widget reports an error for, stops the player; a stuck pick is not
  reloaded, since that would start a two-hour mix over; a finished pick
  moves on to the next item. Pause keeps a pick's place. Picks report no
  duration, so skins treat them as live (no seeking) for now.
- **The state message** gains `url` (the current item's stream or page:
  `player.URL`, `currentMedia.sourceURL`), `author`, `location`, `link` (a
  pick's page, else `""`) and `items` (the playlist's titles).
- **Selecting the item already playing** (a double click's two presses on
  its row) leaves it playing, and the widget is never sent `play` while it
  plays, since it toggles on it. A row's double click opens a pick's page
  only if that row was already the current pick at the first press, so
  double-clicking a row to start a pick does not also open it.
- **The widget can be driven from outside** (the overlay, media keys): a
  pause or play it makes itself pauses or plays the player, so the two
  never disagree. The echo of a pause we sent is not counted as its own.
- **Windows' media overlay** gets the title, the show and the artwork
  through `navigator.mediaSession`, with play, pause, stop, next and
  previous wired back to the player. Not yet seen in the overlay itself;
  see AGENTS.md, Known gaps.

### The core player (ATA-109, 2026-10-11)

- **The playlist is NTS 1 and NTS 2.** On launch NTS 1 plays, whatever was
  playing at exit. Next and previous switch channels and wrap around; while
  stopped or paused they select the channel without playing it.
- **Pause drops the connection, as stop does.** (Reversed by ATA-115:
  pause and stop now load a silent clip, so the media session survives.) Resuming a paused live
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
| `{ "type": "next" }`, `{ "type": "previous" }` | the trusted page: the next or previous playlist item, wrapping around |
| `{ "type": "select", "index": n }` | the trusted page: playlist item `n`, playing it if the player was playing (ATA-113) |
| `{ "type": "mute", "value": true \| false }` | the trusted page |
| `{ "type": "volume", "value": 0..1 }`, `{ "type": "balance", "value": -1..1 }` | the trusted page, clamped |
| `{ "type": "eq", "band": 0..9, "gain": -15..15 }` | the trusted page, clamped |
| `{ "type": "seek", "seconds": n }` | accepted, ignored: live streams cannot seek |
| `{ "type": "drag" }` | Rust: moves the window with the pointer, only while our window is in front and under the pointer with the button down |
| `{ "type": "shape", "width", "height", "rects": [[x, y, w, h], …] }` | Rust: sizes the window and sets its region. Ignored unless the view is 1–4096 px a side and every run is non-empty and inside it, with at most ceil(width / 2) runs per row |
| `{ "type": "close" }`, `{ "type": "minimize" }` | Rust: closes or minimizes the window (ATA-110) |
| `{ "type": "launchUrl", "url": "…" }` | Rust: opens the URL in the default browser, only if it parses as http(s), is at most 2048 characters, and comes 3 s or more after the last one (ATA-110) |
| `{ "type": "picker" }` | Rust: opens the skin picker, unless it is open already or one opened in the last 3 s (ATA-112) |
| `{ "type": "effects", "on": true \| false }` | the trusted page: whether a visualisation is on screen, so wants analyser frames (ATA-114) |

Host to skin: the trusted page calls the `skin_send` command, and Rust
dispatches a `message` event in the skin webview. Today that is, four times
a second (ATA-109):

    { "type": "state", "playState", "channel", "title", "url", "author", "location",
      "link", "items", "time", "duration",
      "volume", "mute", "balance", "eq", "level" }

`playState` is `playing`, `buffering`, `reconnecting`, `paused` or
`stopped`. `duration` is 0 for a live stream, as in WMP: a skin shows its
seek bar disabled. `volume`, `mute`, `balance` and `eq` (ten gains in dB)
are the saved settings, so a skin's controls start where the listener left
them.

From ATA-114, also about 30 times a second while the skin shows a
visualisation and the stream plays:

    { "type": "vis", "bars": [32 × 0..255], "wave": [96 × 0..255] }

The skin also gets `GET /` (the engine page), `GET /engine.js` (the
engine), `GET /skin.wmz` (the skin itself, whole) and `GET /house.wmz` (the
house skin, for when a skin will not load; ATA-112) from the protocol, and
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

## Distribution

### Installer, releases, updates, and CPU (ATA-116, 2026-10-11)

As in the Winamp app (its `docs/decisions.md`, ATA-72), with this app's names.

- **NSIS only.** `.github/workflows/release.yml` builds the installer on a
  `v*` tag and publishes it, with its signature and `latest.json`, as a
  normal GitHub release (not a pre-release, or `releases/latest` would not
  find it). The tag must match `package.json` and `Cargo.toml`. It installs
  per user, with no administrator rights. 1.98 MiB for 0.1.0, against
  2.23 MiB for the Winamp app's 0.1.2; the updater plugin added 0.6 MiB.
- **Updates install on launch, without asking.** A release build checks
  `releases/latest/download/latest.json` once at startup; if it is newer,
  it downloads, installs in passive mode (a small progress window) and
  restarts. The stream drops for a few seconds. Offline or with no release,
  it plays on and tries next launch. Debug builds never check.
- **The update signing key** was made with `npx tauri signer generate`,
  with a password. Both are the repository secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the
  key file and its password live outside the repository on Ata's PC, in
  `%USERPROFILE%\.tauri\nts-desktop-wmp.key` (and `.key.password`). The
  public half is in `tauri.conf.json`. Lose the private key or its password
  and installed copies can never update again, so keep a copy outside
  GitHub. Local builds skip signing: `createUpdaterArtifacts` is on only in
  `src-tauri/tauri.release.conf.json`, which the workflow passes.
- **Actions that see the signing key are pinned to commits**
  (`tauri-action` v0.6.2 and `rust-cache` v2.9.2, the Winamp app's pins).
- **A clean machine is a fresh runner.** This PC runs Windows 11 Home, with
  no Windows Sandbox or Hyper-V (Mika for Ata). The release workflow's
  `install` job downloads the published installer on a new `windows-latest`
  runner and runs `tools/install-check.ps1`: a silent install; the app
  playing, which is one connection to a radiomast audio edge held for 15 s;
  the skin it downloaded, whose md5 must be a working one in
  `compatible.json`; two shots of the window 15 s apart; then a silent
  uninstall that must leave no files, no Settings > Apps entry and no
  shortcuts. It then installs the release before and waits for it to
  update itself to the new one. The evidence is the run's `install-check`
  artifact. Not over DevTools: the runner's WebView2 (153) opened no
  DevTools port for `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` or for its
  per-app policy, and `PrintWindow` drew the window black there; a screen
  capture shows it, clock running.
- **No code signing yet.** SmartScreen warns on first run; the README says
  what to click. The Winamp app's decisions list the options.

**CPU.** ATA-114 measured 29–35 % of one core with a visualisation showing.
Three changes:

- **Each frame redraws only the visualisation.** A full paint draws the
  view twice, with each `effects` element as a solid white box and then a
  solid black one, on an off-screen canvas. The difference says how much of
  the visualisation shows at each pixel and what lies over it
  (`pixels.ts` `overlay`), so a frame redraws just the visualisation's part
  of the canvas, under its cover. It is exact because a visualisation is
  opaque, and it keeps whatever a skin draws over it (anemone's pods,
  clipping, `alphaBlend`). On all 40 working skins that show one at launch,
  plus the house skin, a frame looks the same as before to within 2 levels
  per channel, except Halloween's scrolling title, which moves with the
  clock. Full paints still happen for state changes (the clock, once a
  second) and scrolling text.
- **Scrolling text steps on a timer** at its `scrollingDelay`, not every
  display frame, and such a step reuses the visualisation's cover unless
  the text overlaps it.
- **The trusted page asks for display frames only while frames are
  wanted:** a visualisation on screen and the stream playing. Before, its
  loop ran at 60 Hz all the time.

Measured on release builds side by side (main at `0be9c5c` and this
branch), each run 30 s on a hidden desktop, muted, whole process tree, on a
20-thread machine that other jobs were also using, so runs vary by several
points:

| Skin, playing | Before | After |
|---|---|---|
| Classic, no visualisation | 9.5–11.9 | 6.1–6.9 |
| anemone, Bars | 28.6–41.5 | 24.3–28.1 |
| Halloween, Bars and a scrolling title | 39.7–49.5 | 30.3–30.4 |
| Bootleg House, Bars and a title scrolling every 40 ms | 36.4–43.3 | 27.9–40.4 |
| The Winamp app 0.1.2, its spectrum showing | 12.7–22.5 | |
| The Winamp app 0.1.2, its visualiser clicked off | 5.7 | |

What is left is mostly the frames' trip, not the drawing. Stopping the
frames on Bootleg House took it from about 30 % to 15 %, though each frame
now redraws a few thousand pixels: each of the 30 frames a second is an IPC
call from the trusted page to Rust, then a script evaluated in the skin
webview, then a composite of both webviews. The house skin also repaints in
full 25 times a second for its title. RAM, playing: about 310 MB private
(590 MB working set, which counts shared pages more than once), against
280 MB (540 MB) for the Winamp app.

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
  screenshots was looked over; Kwanzaa, for one, is all visualiser, so its
  candles are black while nothing plays. Rebuilt after ATA-114's
  visualisations merged: the same 59, 97 and 60.
- **On launch** (`skins.rs`): the skin picked in the picker, or else a
  random `works` skin. It comes from the cache
  (`%LOCALAPPDATA%\com.datatuna.ntswmp\skins\<md5>.wmz`), checked against
  its md5, or is downloaded through Rust (archive.org sends no CORS
  headers), checked, and cached. At most one download per launch; one more
  try after a second, since archive.org now and then answers 500 for a file
  it serves a second later. Connecting and the first response byte get
  15 s each, the whole download 120 s. The first paint waits up to 8 s for it, then
  settles for the house skin while the download finishes into the cache.
  A skin that fails to download, fails its md5, or that the engine cannot
  load gives the house skin. Only the latest fetch is worn: a launch
  download that lands after a pick, or after the first paint gave up on
  it, goes into the cache and nowhere else. The cache keeps 100 MB, oldest
  out first, as the Winamp app's does; a worn skin is touched on each
  launch, so a kept one stays.
- **TLS:** `ureq` with the system's TLS (SChannel on Windows). Its
  `native-tls-no-default` feature panics on every https request (ureq 3.4.2
  checks for the `native-tls` feature), so the dependency uses
  `native-tls`, which also carries a bundle of root certificates the app
  does not use. The installer is 1.34 MiB, the exe 3.6 MiB.
- **The picker** opens on a right click on the skin, as WMP's menu offered
  its skin chooser. A skin can send that message too, so it is ignored
  while the picker is open (no taking the focus back) and more often than
  once every 3 s. Closing the player quits the app, picker and all. It is a window of our own (`picker.html`), with a
  capability for three commands: `list_skins`, `choose_skin`, and
  `open_link`, which opens only archive.org `/details/` pages and
  `https://www.nts.live/supporters`. It lists the working skins with their
  publisher folder and a link to each skin's archive.org page, notes the
  download size of those not cached, and credits the archive and links to
  NTS's supporters page. It asks the app every 2 s what is on the window,
  so it follows a launch download landing or a skin falling back to the
  house skin; when a kept skin failed, it says the kept one is tried again
  next launch. archive.org has no preview per skin, so the picker shows
  none; picking one puts it on the window. "A random skin on every launch"
  also puts a new random skin on at once, so the choice shows.
- **No preview images** (Mika for Ata, 2026-10-11). The issue asked for
  archive.org preview images, but the item has none per skin. Drawing our
  own would mean committing or bundling images of third-party skins, which
  the standing rules forbid, and previewing a skin before wearing it would
  mean a download per preview, against one download per launch. So the
  picker shows each skin's name, folder and archive.org link, and a pick
  goes straight onto the window.
- **Remembering the choice** (Mika for Ata, 2026-10-11, carried over from
  ATA-109): a skin picked in the picker opens on every launch and downloads
  nothing. "A random skin on every launch" in the picker forgets the
  choice. If the picked skin fails to load, the house skin shows and the
  choice stays. It is kept in `skin.json` beside the cache, in Rust, since
  Rust serves the skin before the trusted page has loaded.

Checked on a release build on a hidden desktop, with `--mute-audio`,
timing from process start to the skin's first canvas:
- **Ten launches in a row**, from an empty cache, wore ten different skins
  and all played NTS 1. Each downloaded its skin and drew in 2.4 to 4.2 s;
  a launch on a cached skin draws in 1.1 to 1.3 s. (One earlier run of ten
  wore nine: claw twice, the second time from the cache in 1.1 s.)
- **archive.org blocked** (the webview with `--host-resolver-rules="MAP
  archive.org ~NOTFOUND, MAP *.archive.org ~NOTFOUND"`; Rust ignores
  Chromium's flags, so its downloads went to a dead `HTTPS_PROXY`) with an
  empty cache: the house skin, playing, in 6.0 s with the connection
  refused (two tries), and in 9.0 s with it hanging (the 8 s wait).
- **The picker** opened from a right click, listed 59 skins, and put the
  pick on the window (Kenwood_MPXP, Television, Thomas in three runs).
  Relaunches wore it again in 1.1 to 1.3 s with no download. With the kept
  skin removed from the cache and the network blocked, the house skin
  showed and `skin.json` still named it. "A random skin on every launch"
  set `{"skin":null}` and the next launches were random again.
- **Isolation:** `tools/escape.mjs` gives the ATA-107 result on this build,
  and now also tries the picker's commands from the skin: `list_skins`,
  `choose_skin` and `open_link` are each refused by the ACL, and so is
  `list_skins` from the trusted page. Only the picker's own webview has
  them. A skin can open the picker (`{ "type": "picker" }`), which is all
  a right click does.
- Not tried: a real right click with a real mouse (the input came through
  DevTools), and the picker's links, which open the default browser.

### Visualisations: our own bars, scope and ambience (ATA-114, 2026-10-11)

An `<effects>` element draws one of three visualisations of our own, after
the look of WMP's: **Bars** (32 log-spaced spectrum bars, 40 Hz to 16 kHz,
with falling peak caps), **Scope** (the waveform) and **Ambience** (soft
coloured lights that drift and swell with the music). Nothing is copied from
WMP or from the GPL WMP 8 clone. `src/skin/effects.ts` has them.

- **Data.** The trusted page reads a second analyser, tapped from the
  stream before the volume, so the visualisation moves at any volume and
  when muted, as WMP's does. It has 8192 points (6 Hz bins), so the lowest
  bars, 8 Hz apart, each read their own bin. About 30 times a second it sends
  `{ "type": "vis", "bars": [32 × 0..255], "wave": [96 × 0..255] }` through
  `skin_send`, but only while the skin has said a visualisation is on screen
  (`effects` message) and the stream is playing. Each frame repaints the
  skin on the next display frame (only the visualisation since ATA-116).
- **Effect state.** `currentEffectType` and `currentPreset` name the effect
  as `mediacenter.effectType` and `effectPreset` do: "Bars and Waves"
  presets 0 (Bars) and 1 (Scope), and "Ambience" preset 0. An unknown type
  shows Bars. `next()` and `previous()` step round the list and run the
  properties' `_onchange` handlers, which is how anemone, bluegrid and
  cerulean save the choice to `mediacenter`. `mediacenter` is not saved
  across launches.
- **Colours.** `backgroundColor` (black if none) behind, and
  `foregroundColor` for bars and scope if the skin gives one (the house
  skin's amber); otherwise WMP-like green to red.
- **Stopped or paused,** the screen is its background colour.
- **Picks show a flat visualisation.** NTS Picks play through SoundCloud's
  hidden widget, another origin's frame whose audio never enters our Web
  Audio graph (ATA-113). The pick plays, but every bar is 0 and the wave
  sits at 128, so Bars is empty and Scope is a flat line (checked on the
  merged build, anemone, 2026-10-11). The trusted page sends one such flat
  frame, so the screen does not keep the last stream frame, and then none
  while the pick plays: 30 empty frames a second cost about 8% of a core.
- **Clicks.** A subview's drawn background pixels now stop a click, so a
  visualisation behind it (anemone's, `zIndex="-1"` under its yellow pods)
  takes clicks only through the hole. Before, a click on the pod ran the
  visualisation's `onClick="next();"` instead of moving the window.
- **Minimised.** WebView2 is not told when a Tauri window is minimised:
  both pages stayed `visible` and `requestAnimationFrame` kept running.
  Rust now hides both webviews while the window is minimised and shows them
  on restore; the audio plays on.
- **Milkdrop (Butterchurn): not added.** The `butterchurn` package is
  0.7 MB unpacked and `butterchurn-presets` 11.9 MB, against a 3.3 MB
  release binary; it would also need WebGL in the skin webview and the full
  spectrum at frame rate. Three effects of our own cover what the test
  skins ask for.

Measured on the release build, anemone, a 20-thread machine, muted
(`--mute-audio`), whole process tree:

| State | CPU, % of one core |
|---|---|
| Open, playing, visualisation showing (Bars, Scope, Ambience) | 29–35 |
| Open, playing, visualisation hidden (anemone's small mode) | 16 |
| Minimised, playing, before the webviews were hidden | 30 |
| Minimised, playing | 5 |

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
