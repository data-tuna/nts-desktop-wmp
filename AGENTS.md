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

    src/                  The frontend: Vite + TypeScript. Nothing on screen yet.
                          live.ts reads the NTS live API, picks.ts the NTS
                          Picks, mixtapes.ts the Infinite Mixtapes. All three
                          are copied from nts-desktop-winamp; see below.
    src-tauri/            The Rust shell (Tauri 2). Window config in tauri.conf.json,
                          permissions in capabilities/.
    src-tauri/icons/      App icons. For now the Winamp app's pixel-art radio.
    docs/decisions.md     Decisions, research findings, and why.
    tests/                `node --test` tests and their fixtures.
    .github/workflows/    ci.yml checks every PR on windows-latest.

## Commands

    npm install
    npm run tauri dev     The app, with the Vite dev server on :1430
    npm run typecheck     tsc, no emit
    npm run lint          oxlint, warnings fail
    npm run build         Frontend only, into dist/
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
retry.

**Skins are fetched at runtime and never committed.** `.wmz` skins are
third-party works, and many of the classic ones are Microsoft's own. They
come from the archive.org item `windowsmediaplayerskinsarchive`, are cached on
the user's machine, and never enter this repository or the installer
(`.gitignore` blocks `*.wmz`). The repository may hold a compatibility list of
skin names and checksums, never the skins. The only skin that ships is our
own house skin. Be polite to archive.org: one skin per launch, no bulk
downloads.

**Skin scripts never run where they can reach Tauri.** A skin's JScript is
untrusted code. See `docs/decisions.md` (ATA-103) for why a sandboxed iframe
alone is not enough.

**Microsoft's resources are not shipped.** Skins reference
`res://wmploc.dll/...`; we write stand-ins for what skins call, and copy
nothing out of WMP.

**No code from GPL projects.** Marconio (GPL-3.0) and the WMP 8 web clone
(rmellis, GPL-2.0) are for reading, not copying; this project is MIT.
Webamp Modern is MIT: code taken from it keeps its notice and credit.

## Gotchas

**The NTS code is a copy.** `live.ts`, `picks.ts`, `mixtapes.ts` and their
tests come from nts-desktop-winamp (`mixtapes.ts` and the exported `text`
from its PR #9). The Webamp playback parts stay behind. A bug fixed in one
repository needs fixing in the other; each file's header says so.

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

## Known gaps

**No content security policy.** `tauri.conf.json` has `"csp": null`, the
scaffold default.

**The icon is the Winamp app's.** Both apps look the same in the taskbar
until this one gets its own.

**PR CI does not build the Rust side.** It runs typecheck, lint, the frontend
build, the tests and `cargo fmt --check`.

**No release workflow, updater or single-instance lock yet.**
