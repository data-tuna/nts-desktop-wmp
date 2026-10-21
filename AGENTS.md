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
                          settings, answers the skin and fills the playlist
                          and the titles. player.ts keeps the playlist's
                          current item playing and reconnects.
                          live.ts reads the NTS live API; picks.ts and
                          mixtapes.ts parse the NTS Picks and Infinite
                          Mixtapes APIs. All three are copied from
                          nts-desktop-winamp; see Gotchas. widget.ts plays
                          a pick through SoundCloud's hidden widget;
                          analyser.ts analyses its captured audio.
                          picker.ts is the skin picker (picker.html), a
                          trusted page of its own; the selected skin's
                          preview is a skin-engine webview over its pane.
    src/skin/             The skin engine, which runs in the skin webview:
                          wmz.ts unzips, wms.ts decodes and parses the .wms,
                          engine.ts lays out and paints the view, runs the
                          skin's scripts and handles the pointer, runtime.ts
                          is the WMP object model the scripts see, effects.ts
                          draws the visualisations and Album Art,
                          milkdrop.ts runs Butterchurn for Milkdrop,
                          pixels.ts holds the pixel helpers its tests share.
                          main.ts is the entry; index.html the page.
    skins/house/          The house skin, the one skin that ships: house.wms,
                          the layered SVGs in art/ it is drawn from, build.mjs
                          that renders them to bitmaps and zips house.wmz,
                          and house.wmz itself, committed and built into the
                          binary.
    skins/compatible.json Every .wmz in the archive.org item: path, md5,
                          size, and works / partial / broken, with what the
                          engine logged. Built by tools/compat.mjs; the app
                          wears only "works". Never the skins themselves.
    src-tauri/            The Rust shell (Tauri 2). skins.rs picks, downloads
                          and caches the skin; loopback.rs captures what the
                          app plays, for a pick's visualisation. Window
                          config in tauri.conf.json, permissions in
                          capabilities/.
    src-tauri/icons/      App icons. For now the Winamp app's pixel-art radio.
    docs/decisions.md     Decisions, research findings, and why.
    docs/research/        Longer research notes, such as how WMP 7.1's own
                          skin engine behaves (wmp-skin-engine.md, ATA-212).
    tests/                `node --test` tests and their fixtures.
    tools/                DevTools and window probes; see Observing the app.
    .github/workflows/    ci.yml checks every PR on windows-latest; release.yml
                          publishes a v* tag and installs it on a fresh runner.

## Commands

    npm install
    npm run tauri dev     The app, with the Vite dev server on :1430
    npm run typecheck     tsc, no emit
    npm run lint          oxlint, warnings fail
    npm run build         Frontend only: dist/, and the skin engine in dist-skin/
    npm run build:skin    The skin engine alone (dist-skin/engine.js)
    npm run build:house   Rebuild skins/house/house.wmz from its sources
    node tools/compat.mjs Rebuild skins/compatible.json (downloads the item once; slow)
    npm test              node --test on tests/ (Node 22.18+ runs the .ts imports)
    npm run check         lint + typecheck + build + test; CI runs this plus cargo fmt
    npm run tauri build   Release binary and the NSIS installer (slow, minutes)

    cargo fmt --manifest-path src-tauri/Cargo.toml --check

Releasing: bump `version` in `package.json` and `src-tauri/Cargo.toml`, merge,
then push the tag (`git tag v0.1.1 && git push origin v0.1.1`). The release
workflow signs the installer for the updater with the repository secrets;
`docs/decisions.md` (ATA-116) says where the key is kept.

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

**The app always opens on NTS 1 and plays it, unmuted.** Volume, balance and
the EQ are remembered (`localStorage` in the trusted page); the channel and
mute are not (ATA-196).
The skin picked in the picker is remembered too (`skin.json` beside the skin
cache); with none picked, every launch wears a random working skin.

**The playlist is NTS 1, NTS 2, the picks, then the mixtapes** (ATA-197).
`playlist()` in `player.ts` builds it; everything else indexes that list.

**No SoundCloud credit or name.** Ata dropped the credit SoundCloud's terms
ask for and accepts the risk (ATA-197, 2026-10-20). A pick's title is the
episode's, from the picks API, and a double click on it opens the episode
on nts.live, not on SoundCloud (ATA-198). Do not add "SoundCloud" or the
uploader back to the skin, the tray, the media overlay or a link.

**Skins are fetched at runtime and never committed.** `.wmz` skins are
third-party works, and many of the classic ones are Microsoft's own. They
come from the archive.org item `windowsmediaplayerskinsarchive`, are cached on
the user's machine, and never enter this repository or the installer
(`.gitignore` blocks `*.wmz`). The repository may hold a compatibility list of
skin names and checksums, never the skins. The only skin that ships is our
own house skin, `skins/house/`, the one `.wmz` the repository holds. Be
polite to archive.org: one skin per launch, no bulk downloads. The app
downloads at most one skin per launch, plus one for each skin the listener
selects in the picker, to preview or wear it, and never two at once for
the same skin. `tools/compat.mjs` is the one bulk download, run by hand
when the engine changes: it fetches each file once, a few seconds apart,
into a cache outside the repository, and fetches only what is missing on a
rerun.

**Skin scripts never run where they can reach Tauri.** A skin's JScript is
untrusted code. It runs only in the `skin` webview, which no capability
names, and talks to the trusted page only through the `skin` protocol's
fixed message list. The picker's `preview` webview is the same, and Rust
drops every message from it but its shape (ATA-193). Capabilities match
by `webviews`, never `windows` (the skin webview is a child of the main
window), and every app command goes in the app manifest in `build.rs`.
Everything the skin protocol serves carries a CSP with no network and no
frames. Run `node tools/escape.mjs` after touching any of it, and after
every Tauri upgrade. `docs/decisions.md` (ATA-107) has the protocol and the
evidence.

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
names the commit. The Webamp playback parts stay behind; `main.ts` and
`widget.ts` do that job here. A bug fixed in one repository needs fixing in the
other. Only this repository's headers say so: the Winamp copies carry no
such note.

**The NTS live API is cached for 15 minutes.** It answers with
`Cache-Control: max-age=900` and CloudFront honours it, so a bare request
can return the show that ended a quarter of an hour ago. `live.ts` adds a
query string that changes once a minute. `broadcast_title` arrives
HTML-escaped (`&amp;`).

**Picks play through SoundCloud's widget, not our audio graph.** It is a
`w.soundcloud.com` frame in the trusted page, as in the Winamp app, never
`/api/v2/resolve-stream`. Its audio never reaches our Web Audio graph, so
during a pick the volume and mute follow (through the widget's
`setVolume`) but the EQ, balance and the visualiser's level do not. The
visualisation follows the pick through process loopback instead: Rust
captures what the app's own processes play (ATA-199). Loopback hears
silence from a hidden desktop, so a pick's visualisation stays still
there; it can only be checked on a real desktop. Tauri
injects its internals into that frame too; the ACL refuses it (`Command
skin_send not allowed by ACL`, checked on a release build), because no
capability names a remote origin. Keep it that way.

**Windows' media overlay needs `HardwareMediaKeyHandling`.** WebView2 keeps
`navigator.mediaSession` to itself unless that Chromium feature is on (the
Winamp app found this), so both browser-argument lists enable it.

**ICY titles are empty on these streams.** The title comes from the live API
or the fallback.

**With Web Audio, the `<audio>` element needs `crossOrigin = "anonymous"`.**
Without it the stream plays as silence while the clock runs.

**archive.org downloads send no CORS headers.** Fetch skins through Rust.
archive.org also answers 500 now and then for a file it serves a second
later; `skins.rs` tries a failed download once more.

**The compatibility list is only as good as its checks.** `tools/compat.mjs`
marks a skin "works" when the engine draws it in headless Edge with no
failed script, missing image or unknown element, the skin has play and stop
(or pause) controls, and the canvas holds no more than 20 pixels of the key
colour `#FF00FF`. It cannot see a skin that draws but looks wrong, so look
at the screenshots it leaves next to the cached skins (`<md5>.png`). Rerun it
after engine changes: `npm run build:skin`, then `node tools/compat.mjs`.

**Tauri's asset protocol sends no CORS headers.** A frame with an opaque
origin (`sandbox` without `allow-same-origin`) cannot load module scripts
from the app in a release build. Inline the code or use another protocol.

**This app and the Winamp app run side by side.** They differ in identifier
(`com.datatuna.ntswmp` here, `com.datatuna.ntswinamp` there), so each has its
own `%LOCALAPPDATA%\<identifier>` folder, WebView2 profile and
single-instance lock (`<identifier>-sim`); in executable
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
    docs/research/wmp-skin-engine.md
                          What WMP 7.1's skin engine really does, read with
                          REA, and where ours differs (ATA-212).

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

    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9355 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --enable-features=HardwareMediaKeyHandling"
    $env:NTS_WMP_SKIN = "C:\path\to\a\skin.wmz"      the skin to draw; unset, the picked or a random one
    npm run tauri dev

or, to keep the window off the screen entirely, start the built exe on a
hidden desktop (a debug build needs `npx vite` running for its pages):

    powershell -File tools/hidden-run.ps1 src-tauri/target/release/nts-desktop-wmp.exe

    node tools/cdp.mjs 9355 main|skin|preview "<expr>"   Evaluate in a webview
    node tools/click.mjs 9355 "#play"            Click an element in the skin
    node tools/escape.mjs 9355 webview|frame|preview   The ATA-107 escape attempts
    powershell -File tools/window-shot.ps1 "NTS Radio Bootleg Media Player" shot.png
    powershell -File tools/region-shot.ps1 "NTS Radio Bootleg Media Player" shot.png
    powershell -File tools/ram.ps1 nts-desktop-wmp
    powershell -File tools/cpu.ps1 nts-desktop-wmp 30   % of one core, whole tree
    powershell -File tools/install-check.ps1 <setup.exe>  Installs for real; see below
    node tools/proxy.mjs 8899                    A CONNECT proxy you can cut; see below

A debug build reads `dist-skin/engine.js` each time the skin page loads, so
after `npm run build:skin` a reload of the skin webview picks up engine
changes without rebuilding the app. To look at the engine in a browser, with
no app at all:

    npm run build:skin
    node tools/skin-preview.mjs C:\path\to\a\skin.wmz     then open http://localhost:1432/

A stand-in host in that page answers the skin with state as the trusted page
does, but plays nothing; `/?play` starts it playing, as the app does on
launch. In either place, `__wmpScope` in the skin webview is what skin code sees:
`__wmpScope.player.status`, `__wmpScope.<element id>.visible`.

`install-check.ps1` installs the app, plays it, and uninstalls it, as the
release workflow does on a fresh runner: on this machine it would install a
real copy, so leave it to the workflow. `cpu.ps1` and `ram.ps1` take the
first process with that name, so stop other copies first, or copy the exe
under another name.

`region-shot.ps1` greys out what the window region cuts away, as Windows
reports it. `escape.mjs` reloads the trusted page when it finishes, since its
forced-fallback test leaves that page on `postMessage` IPC.

**Other copies of the app share its profile.** Every copy with the
identifier `com.datatuna.ntswmp`, whoever built it, uses the same WebView2
folder under `%LOCALAPPDATA%`. A second copy started with other browser
arguments (another DevTools port) panics in setup with `0x800700AA`, "The
requested resource is in use", and exits with `0xC0000409`. One started with
the same arguments shares the first one's browser process, which dies with
whichever copy is closed first. The single-instance lock hands a second
launch over to the first copy before any webview exists, but only when both
run on the same desktop: the lock finds the first copy's window with
`FindWindow`, which looks at its own desktop only. So when testing, give the
run its own desktop name (`hidden-run.ps1 <exe> <name>`), DevTools port and
`WEBVIEW2_USER_DATA_FOLDER`, and check which process a port belongs to
before you poke it: another agent's copy may be listening on 9355.

**Local builds never update themselves.** The updater's endpoint is only
in `src-tauri/tauri.release.conf.json`, which the release workflow passes.
Don't pass that file to a local build you run: it would install the latest
release over the installed copy, and close it (ATA-204).

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
for a person. `PrintWindow` does draw a window on a hidden desktop if the
process calling it runs there too: start `powershell.exe` with
`region-shot.ps1` on that desktop. Windows lists no media session for an app
on a hidden desktop, so the media keys and the overlay can only be checked
on the real one.

## Known gaps

**Dragging the window is unverified.** Rust follows the cursor while the
primary button is down (`win32::drag` in `lib.rs`), because `start_dragging`
did nothing under the skin webview. Nobody has dragged it with a real mouse
yet, nor clicked the tray menu (its "Show on nts.live" and Mute entries
included), nor moved the window to a monitor with another
scale (the shape is redone on `ScaleFactorChanged`).
ATA-115 has the list of checks for a person.

**Stop from Windows ends the media session.** The overlay's Stop button, or
a Stop media key, stops the player, and WebView2 then drops the session, so
the Play key cannot start it again: use the window or the tray. Pause, and
Stop from the skin or the tray, keep the session.

**A launch while the app is closing does nothing.** The closing copy still
holds the single-instance lock, so the new one hands over to it and exits.

**The trusted page has no content security policy.** `tauri.conf.json` has
`"csp": null`, the scaffold default. The skin protocol sends its own CSP
(`SKIN_CSP` in `lib.rs`).

**60 of the archive's 216 skins draw nothing yet.** Most are The Skins
Factory's. 54 open on a view that only hands over to the player in a later
one: a `previewView` for WMP's skin chooser, or a `mediaSwitcherView` or
`versionView`. The engine draws only the first view (below), so
`compatible.json` marks them broken until it opens others.

**Previews are drawn live, never kept as images** (ATA-193). Each selection
in the picker loads the skin into the preview webview again, from the
cache: about 0.3 s. No thumbnails are saved.

**The icon is the Winamp app's.** Both apps look the same in the taskbar
until this one gets its own.

**PR CI does not build the Rust side.** It runs typecheck, lint, the frontend
build, the tests and `cargo fmt --check`.

**A visualisation costs about 10–25 points of a core** (ATA-116, ATA-122).
With one showing, the app uses about
15–33 % of a core, depending on the skin (5–7 % without; the Winamp app
about 18 % with its spectrum). The top of that range is Bootleg House, whose
scrolling title repaints the whole skin. Each frame redraws only the
visualisation, so most of that is the frames' trip: an IPC call from the
trusted page, a script evaluated in the skin webview, a composite of both
webviews. Frames go 20 a second, and none while the player is minimised or
other windows cover all of it. Milkdrop costs about the same as Bars to 9
points more (ATA-167).

**Only a skin's first view is drawn.** `theme.openView` and
`theme.currentViewID` are logged and ignored, so circle's video, playlist
and settings views and 9SeriesDefault's compact view never open. 47 of the
136 listed skins with a playlist have it only in a view the engine never
opens (circle, Kenwood_MP7, portals, QuantumRedshift and more; ATA-198).

**Some playlists still cannot be opened** (ATA-198). The skin's own
button or script fails to show them: Faith Hill, Unity, UPRISING and Kids
call functions from a `.js` that no `scriptFile` names; tubeframe's
toggle recurses until the stack overflows; Cablemusic's hangs; Crystalball
leaves the list's subview hidden; TwinBlade's and Bluesky's playlist
buttons are under other parts of the skin; Darkling's sit in subviews
chosen by screen size, all hidden. Light text on a
light list (Secura, deepbluesomething, Stealth, NPR, raveworld) is the
skin's own choice of colours.

**Kenwood_MP7 loses its display.** It is listed as "works", but its
`mainMeta` subview (title, clock, seek bar, EQ) is never drawn or hit,
though its script sets it visible (ATA-170). Kenwood_MPXP has the same
markup and likely the same fault.

**Video, item and drop-down playlists, and popups are not drawn.**
`<playlist>` lists the channels, mixtapes and picks, with a scroll bar
when they do not all fit, and scrolls the playing row's name when it is
too long (ATA-191); it has no columns. It lies over every image in the
view and is part of the window shape, as WMP's own window was (ATA-198).
Its `backgroundImage` is not drawn. Nobody has dragged that scroll bar
with a real mouse yet. Their methods
(`setColumnResizeMode`, `appendItem`) are logged and do nothing.

**Album Art, three visualisations and Milkdrop** (ATA-114, ATA-167,
ATA-190, ATA-200): Album Art draws the show's picture alone; bars, scope
and ambience are our own; Milkdrop is Butterchurn with 29 presets, one
`next()` each. A right click on the visualisation opens a menu of all of
them, Album Art first. The chosen effect is saved in the skin webview's
`localStorage`; the first launch shows Album Art. Nobody has clicked that
menu with a real mouse yet.

**Nobody has looked at the media overlay itself.** Windows lists the app's
session with its title and show (`NTS 1: <show> - <location>`), and plays,
pauses and stops it, through the same API the overlay uses (ATA-115). The
flyout has not been seen on screen.

**Nobody has seen a pick's visualisation move** (ATA-199). The capture
reads silence on a hidden desktop, so the frames were checked there only
for their rate and cost.

**Fast forward and rewind are drawn disabled,** and so are seek sliders
except during a pick: a live stream has no length.

**A skin's `onClose` runs only when it closes the window itself** (its close
button or `view.close()`), not when Windows closes the app, so preferences a
skin saves there may not be saved.

**The house skin has no close or minimize button yet,** though the skin
protocol now has messages for both (ATA-110).
