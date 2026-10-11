# AGENTS.md

Conventions for anyone, person or agent, working in this repository. Read
this before touching anything. The *decisions* live in `docs/decisions.md`;
this file is how the project is worked on and what will bite you.

## What this is

**nts-desktop-wmp**, "NTS Radio Bootleg Media Player": an unofficial Windows
Media Player-style desktop player for [NTS Radio](https://www.nts.live/). It
opens straight into NTS 1, switches to NTS 2 with one click, and wears
classic Windows Media Player skins (`.wmz`), drawn by our own skin engine.
It is the sister app to
[nts-desktop-winamp](https://github.com/data-tuna/nts-desktop-winamp), which
does the same with Winamp skins through Webamp.

**The app is unofficial, and it has to look unofficial.** It is a fan-made
player for someone else's radio station, wearing someone else's skins. NTS
does not endorse it. Nothing in the window, the installer, the icon or the
README may use the NTS logo or name in a way that reads as official, and the
app must link listeners to `https://www.nts.live/supporters`.

Windows comes first, macOS second. Nothing in the Windows work should make
macOS harder than it needs to be.

Written in English.

## Layout

    src/                  The frontend: Vite + TypeScript. main.ts is the
                          trusted page: it owns the audio, saves the
                          settings and answers the skin. player.ts keeps a
                          channel playing and reconnects.
                          live.ts reads the NTS live API; picks.ts and
                          mixtapes.ts parse the NTS Picks and Infinite
                          Mixtapes APIs. All three are copied from
                          nts-desktop-winamp; see Gotchas.
    src/skin/             The skin engine, which runs in the skin webview:
                          wmz.ts unzips, wms.ts decodes and parses the .wms,
                          engine.ts lays out and paints the view, runs the
                          skin's scripts and handles the pointer, runtime.ts
                          is the WMP object model the scripts see, effects.ts
                          draws the visualisations, pixels.ts holds the pixel
                          helpers its tests share. main.ts is the entry;
                          index.html the page.
    skins/house/          The house skin, the one skin that ships: house.wms,
                          the layered SVGs in art/ it is drawn from, build.mjs
                          that renders them to bitmaps and zips house.wmz,
                          and house.wmz itself, committed and built into the
                          binary.
    src-tauri/            The Rust shell (Tauri 2). Window config in tauri.conf.json,
                          permissions in capabilities/.
    src-tauri/icons/      App icons. For now the Winamp app's pixel-art radio.
    docs/decisions.md     Decisions, research findings, and why.
    tests/                `node --test` tests and their fixtures.
    tools/                DevTools and window probes; see Observing the app.
    .github/workflows/    ci.yml checks every PR on windows-latest.

## Commands

    npm install
    npm run tauri dev     The app, with the Vite dev server on :1430
    npm run typecheck     tsc, no emit
    npm run lint          oxlint, warnings fail
    npm run build         Frontend only: dist/, and the skin engine in dist-skin/
    npm run build:skin    The skin engine alone (dist-skin/engine.js)
    npm run build:house   Rebuild skins/house/house.wmz from its sources
    npm test              node --test on tests/ (Node 22.18+ runs the .ts imports)
    npm run check         lint + typecheck + build + test; CI runs this plus cargo fmt
    npm run tauri build   Release binary and the NSIS installer (slow, minutes)

    cargo fmt --manifest-path src-tauri/Cargo.toml --check

Rust lives in `%USERPROFILE%\.cargo\bin`. A shell that cannot find `cargo` is
missing that directory on `PATH`.

**A change is not finished until `npm run check` passes and you have run the
app and looked at it.** A skin engine draws bitmaps that a typecheck knows
nothing about.

## Invariants

**Streams come from `https://streams.radiomast.io/nts1` and `/nts2`.** They
are MP3 at 256 kbps and send open CORS headers, which matter as soon as audio
goes through Web Audio (skin visualisers, the equaliser).
`stream-relay-geo.ntslive.net/stream` answers with a 302 to radiomast that
carries no CORS headers, so a cross-origin load fails at that first hop.
radiomast then redirects to a regional `audio-edge-*.radiomast.io` host, with
CORS on every hop. Those edge hosts move, so never hard-code one: always
start from `streams.radiomast.io`. Mixtapes follow the same rule; see
`mixtapes.ts`.

**Playback never depends on the now-playing API.** `https://www.nts.live/api/v2/live`
is undocumented and can change or vanish. When it fails, the titles fall back
to "NTS 1" and "NTS 2" and the music keeps playing. The picks and mixtapes
APIs are undocumented too: when they fail, the app plays just the channels.

**A dropped stream reconnects to the same channel.** Retry with backoff; never
skip to the next channel on a drop. Pause and stop are never undone by a
retry. `player.ts` does this, and treats an error, an `ended` event and a
clock stuck for 10 s alike.

**The app always opens on NTS 1 and plays it.** Volume, mute, balance and the
EQ are remembered (`localStorage` in the trusted page); the channel is not.

**Skins are fetched at runtime and never committed.** `.wmz` skins are
third-party works, and many of the classic ones are Microsoft's own. They
come from the archive.org item `windowsmediaplayerskinsarchive`, are cached on
the user's machine, and never enter this repository or the installer
(`.gitignore` blocks `*.wmz`). The repository may hold a compatibility list of
skin names and checksums, never the skins. The only skin that ships is our
own house skin, `skins/house/`, the one `.wmz` the repository holds. Be
polite to archive.org: one skin per launch, no bulk downloads.

**Skin scripts never run where they can reach Tauri.** A skin's JScript is
untrusted code. It runs only in the `skin` webview, which no capability
names, and talks to the trusted page only through the `skin` protocol's
fixed message list. Capabilities match by `webviews`, never `windows` (the
skin webview is a child of the main window), and every app command goes in
the app manifest in `build.rs`. Everything the skin protocol serves carries
a CSP with no network and no frames. Run `node tools/escape.mjs` after
touching any of it, and after every Tauri upgrade. `docs/decisions.md` (ATA-107) has the protocol and the evidence.

**Microsoft's resources are not shipped.** Skins reference
`res://wmploc.dll/...`; we write stand-ins for what skins call, and copy
nothing out of WMP.

**No code from GPL projects.** Marconio (GPL-3.0) and the WMP 8 web clone
(rmellis, GPL-2.0) are for reading, not copying; this project is MIT.
Webamp Modern is MIT: code taken from it keeps its notice and credit.

## Gotchas

**The NTS code is a copy.** `live.ts`, the parsing half of `picks.ts`,
`mixtapes.ts` and their tests come from nts-desktop-winamp (`live.ts` and
`mixtapes.ts` from its unmerged PR #9, which exports `text`); each header
names the commit. The Webamp playback parts stay behind, so nothing fetches
picks or mixtapes yet. A bug fixed in one repository needs fixing in the
other. Only this repository's headers say so: the Winamp copies carry no
such note.

**The NTS live API is cached for 15 minutes.** It answers with
`Cache-Control: max-age=900` and CloudFront honours it, so a bare request
can return the show that ended a quarter of an hour ago. `live.ts` adds a
query string that changes once a minute. `broadcast_title` arrives
HTML-escaped (`&amp;`).

**ICY titles are empty on these streams.** The title comes from the live API
or the fallback.

**With Web Audio, the `<audio>` element needs `crossOrigin = "anonymous"`.**
Without it the stream plays as silence while the clock runs.

**archive.org downloads send no CORS headers.** Fetch skins through Rust.

**Tauri's asset protocol sends no CORS headers.** A frame with an opaque
origin (`sandbox` without `allow-same-origin`) cannot load module scripts
from the app in a release build. Inline the code or use another protocol.

**This app and the Winamp app run side by side.** They differ in identifier
(`com.datatuna.ntswmp` here, `com.datatuna.ntswinamp` there), so each has its
own `%LOCALAPPDATA%\<identifier>` folder and WebView2 profile; in executable
(`nts-desktop-wmp.exe`); in product name, which names the install folder and
the Settings > Apps entry; and in dev port (1430 here, 1420 there). Keep all
four distinct.

**A `.wms` is not XML a parser will take.** Attributes repeat (the last one
wins, as in WMP: cerulean's screens and circle's duration need it), script
attributes hold raw `&&` and `<`, and close tags differ in case from their
open tags. `wms.ts` tokenizes forgivingly; don't swap in `DOMParser`.

**Skin scripts are global code.** `engine.ts` runs each script file with
indirect `eval` inside `with (__wmpScope)`, so the skin's functions and
variables land on the skin webview's global object, where handlers and
`jscript:` attributes find them, and `eval("eq" + i + ".down = …")` inside a
skin function still sees element ids. Each file first copies its top-level
functions to the global object: inside the `with` block they would
otherwise appear only when execution reaches them. Element members are
case-insensitive, as COM's are, but handler attributes are not members:
`onLoad="OnLoad();"` must reach the function, not the attribute. Two skins never share a webview,
so their globals never meet.

**Node's `TextDecoder("windows-1252")` is Latin-1.** It gets 0x80-0x9F
wrong (`€`, curly quotes), so `wms.ts` maps that range itself. WebView2 gets
it right, which is why only the tests would notice.

**The house skin's bitmaps are built, never edited.** Change an SVG in
`skins/house/art/` or `house.wms`, run `npm run build:house`, and commit
`house.wmz` with it; a test fails when they disagree. Anything that touches
the key colour (`#FF00FF`) must have crisp edges (`shape-rendering=
"crispEdges"`, or sit 1.5 px inside a crisp shape): a smoothed edge blends
into it and leaves a pink fringe the transparency key cannot remove. The
build refuses pixels that are not opaque.

**`tauri dev` needs port 1430 free.** Vite runs with `strictPort`, so a
leftover dev server makes the next launch fail rather than pick another port.

## Where the decisions are

    docs/decisions.md     The stack, the skin source, the ATA-103 research.
                          Add an entry when you make or reverse a decision.

Project tracking lives in the Multica project *nts-desktop-wmp*, not here.
Ata decides anything that is not already written down.

## Working agreement

One issue at a time; the issue is the contract and its "Done when" is the
bar.

Branches are named `agent/<name>/<issue-key>-short-description`, for example
`agent/lama/ata-106-bootstrap`. Nothing is committed to `main` directly.
Every change lands as a PR against `main` with the issue key in the title
(`ATA-106: ...`), and goes through the review loop: the reviewer's findings
are fixed or answered with evidence until it approves with none left.

Verify, don't assert. Run the app and observe: screenshots of the window,
audio actually playing, measured RAM and installer size. UI changes carry
before and after screenshots in the PR.

Keep this file, `CLAUDE.md` and `docs/decisions.md` true in the same branch
as the change that makes them stale.

## Observing the app

Start it with WebView2's DevTools port open. The variable replaces the
browser arguments in `tauri.conf.json`, so repeat them:

    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9355 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required"
    $env:NTS_WMP_SKIN = "C:\path\to\a\skin.wmz"      the skin to draw; unset, the house skin
    npm run tauri dev

or, to keep the window off the screen entirely, start the built exe on a
hidden desktop (a debug build needs `npx vite` running for its pages):

    powershell -File tools/hidden-run.ps1 src-tauri/target/release/nts-desktop-wmp.exe

    node tools/cdp.mjs 9355 main|skin "<expr>"   Evaluate in either webview
    node tools/click.mjs 9355 "#play"            Click an element in the skin
    node tools/escape.mjs 9355 webview|frame     The ATA-107 escape attempts
    powershell -File tools/window-shot.ps1 "NTS Radio Bootleg Media Player" shot.png
    powershell -File tools/region-shot.ps1 "NTS Radio Bootleg Media Player" shot.png
    powershell -File tools/ram.ps1 nts-desktop-wmp
    node tools/proxy.mjs 8899                    A CONNECT proxy you can cut; see below

A debug build reads `dist-skin/engine.js` each time the skin page loads, so
after `npm run build:skin` a reload of the skin webview picks up engine
changes without rebuilding the app. To look at the engine in a browser, with
no app at all:

    npm run build:skin
    node tools/skin-preview.mjs C:\path\to\a\skin.wmz     then open http://localhost:1432/

A stand-in host in that page answers the skin with state as the trusted page
does, but plays nothing; `/?play` starts it playing, as the app does on
launch. In either place, `__wmpScope` in the skin webview is what skin code
sees: `__wmpScope.player.status`, `__wmpScope.<element id>.visible`.

`region-shot.ps1` greys out what the window region cuts away, as Windows
reports it. `escape.mjs` reloads the trusted page when it finishes, since its
forced-fallback test leaves that page on `postMessage` IPC.

**Testing reconnect.** Add `--proxy-server=http://127.0.0.1:8899` to the
browser arguments, run `node tools/proxy.mjs 8899`, and cut it with
`curl "http://127.0.0.1:8899/cut?seconds=30"`. Its log shows each tunnel
opening and closing. DevTools' offline emulation does not interrupt a stream
that is already playing, so it proves nothing here. Add `--mute-audio` too:
the stream plays and the analyser still reads its level, but nothing comes
out of the speakers. Give the run its own `WEBVIEW2_USER_DATA_FOLDER` and
DevTools port if another copy of the app may be running.

**Never drive the real mouse or keyboard, and keep the app off the screen.**
The machine is in use. Use `hidden-run.ps1`, and keep the volume at 0 if you
press Play. Clicks go through DevTools input events (`click.mjs`); anything
that needs a real pointer, such as dragging the window, is a manual check
for a person. The window shots need the visible desktop, so ask first.

## Known gaps

**Dragging the window is unverified.** Rust follows the cursor while the
primary button is down (`win32::drag` in `lib.rs`), because `start_dragging`
did nothing under the skin webview. Nobody has dragged it with a real mouse
yet.

**The trusted page has no content security policy.** `tauri.conf.json` has
`"csp": null`, the scaffold default. The skin protocol sends its own CSP
(`SKIN_CSP` in `lib.rs`).

**The icon is the Winamp app's.** Both apps look the same in the taskbar
until this one gets its own.

**PR CI does not build the Rust side.** It runs typecheck, lint, the frontend
build, the tests and `cargo fmt --check`.

**No release workflow, updater or single-instance lock yet.**

**Only a skin's first view is drawn.** `theme.openView` and
`theme.currentViewID` are logged and ignored, so circle's video, playlist
and settings views and 9SeriesDefault's compact view never open.

**Video, item and drop-down playlists, and popups are not drawn.**
`<playlist>` lists the two channels only. Their methods
(`setColumnResizeMode`, `appendItem`) are logged and do nothing.

**Three visualisations, no Milkdrop** (ATA-114): bars, scope and ambience,
our own. The chosen effect is not saved across launches (`mediacenter`
starts empty each time).

**Fast forward, rewind and seek sliders are drawn disabled:** a live stream
has no length.

**A skin's `onClose` runs only when it closes the window itself** (its close
button or `view.close()`), not when Windows closes the app, so preferences a
skin saves there may not be saved.

**The house skin has no close or minimize button yet,** though the skin
protocol now has messages for both (ATA-110).
