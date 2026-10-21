# Decisions

What was decided, by whom, and why. Newest first within each section. When a
decision is reversed, leave the old entry and add the new one beside it with
the evidence.

## Stack

### A local skin library for development, never committed (ATA-220, 2026-10-21)

Ata (ATA-220) downloaded 90 `.wmz` skins and asked to copy them into the
repo and pick from them in a second menu, "i think having them all local
for our development is better for us". Committing them would break the
standing rule that skins never enter this public repository, so they
live in the checkout but outside git.

- **Where.** `skins/local/`, gitignored (`*.wmz` already was). Copy the
  `.wmz` files straight into that folder by hand, with no subfolders: only
  its top level is read. Rust lists the folder at a path fixed at build
  time (`CARGO_MANIFEST_DIR/../skins/local`), so only a build from a
  checkout that has the folder shows them; CI and release builds list
  none.
- **Picker.** A select above the list switches between the archive.org
  menu, as before, and "Local library (N)", shown only when the folder has
  skins. Local skins preview and wear like the others, are read from disk
  with no cache or download, and can be kept for every launch
  (`local/<file>.wmz` in `skin.json`). Every build shares `skin.json`, so
  a build that cannot find a kept local skin (the installed release, say)
  wears a random one instead of the house skin on every launch.
- **Not checked.** The local skins are not on the compatibility list, so
  some draw nothing (Batman Begins is "broken" there); the preview says
  "No preview" and wearing one gives the house skin. They are never drawn
  at random.

### Album Art: the show's picture alone, first and by default (ATA-200, 2026-10-20)

Ata (ATA-163): "once you're in a visualisation you can't go back to the
general visualisation of the show, like the images." Mika read it as WMP's
Album Art: the picture alone, no text (ATA-190 dropped the text card).
This partly reverses ATA-190's "Default and fallback": the first launch now
shows Album Art, not Bars.

- **What.** A fifth effect, **Album Art** (`effectType` "Album Art",
  preset 0), draws the show's picture over the whole `effects` area,
  cropped and centred, and nothing else. With no picture it is the
  element's background colour. On a channel or a pick the picture is the
  media overlay's: the live API's `media.picture_small`, or the picks
  API's episode picture. On a mixtape it is the mixtapes API's
  `media.picture_small` (`mixtapes.ts` reads it again, as ATA-166 did).
- **Easy to reach.** It is index 0 of `EFFECTS`: first in the right-click
  menu, first in the `next()`/`previous()` cycle (after the last Milkdrop
  preset comes Album Art), and what an unknown or missing saved effect
  reads as, so the default on a first launch. A saved choice still wins.
- **Isolation.** As ATA-166: the trusted page fetches the picture
  (`media*.ntslive.co.uk` sends `Access-Control-Allow-Origin: *`) and sends
  it as a `data:` URL in an `art` message through `skin_send`, when the
  picture changes and again on each skin's first paint (its `effects`
  message). The skin CSP is unchanged. `tools/escape.mjs` on the release
  build: every attempt from the skin is still refused.
- **CPU.** Album Art wants no analyser frames (`effects` `on: false`); none
  arrived in 3 s. A picture that fails to load is fetched again a minute
  later, since the URL stays the same for the whole show. Release build, anemone, NTS 1 playing muted on a hidden
  desktop, 30 s samples alternated on one running app: Album Art 6.1, 6.8,
  4.3 % of one core, visualisation hidden 5.3, 5.6, 4.7 %. Bars in an
  earlier launch: 21.9 %.
- **Release build, hidden desktop.** anemone, bluegrid and the house skin
  open on Album Art and show the show's picture on NTS 1 and NTS 2, with
  no text (screenshots on ATA-200). On anemone, from Milkdrop, a right
  click on the area followed by the menu's pick of entry 0 (sent as the
  menu sends it) goes straight back to the picture. Nobody has clicked the
  menu with a real mouse.

### The visualisation during a pick: the app's own output (ATA-199, 2026-10-20)

Ata (ATA-163): "why doesn't the visualiser, Milkdrop etc., work when I'm
playing something from NTS Picks?" A pick plays in SoundCloud's widget, a
cross-origin frame, so its audio never reaches our Web Audio graph.

- **Process loopback.** Rust captures what the app's own process tree
  plays, with Windows' process loopback (include tree, Windows 10 2004 or
  later), through the `wasapi` crate (MIT, on the `windows` 0.62 crate
  Tauri already builds). `loopback.rs` keeps the newest 8192 mono samples
  in memory. The trusted page asks for them with `pick_audio` at each
  frame, and gets raw bytes back. The capture starts at the first ask and
  stops a second after the last, so it runs only while a pick plays, a
  visualisation shows, and the player is neither covered nor minimised
  (ATA-122). Nothing is recorded, written or sent. It needs no SoundCloud
  API, client ID or network access.
- **The same frames.** `analyser.ts` does to the samples what the
  AnalyserNode does to a stream (Blackman window, FFT, 0.8 smoothing, the
  same dB range), so Bars, Scope, Ambience and Milkdrop get their frames
  the same way on both. The capture comes after the widget's volume, so
  the samples are divided by it: the visualisation moves at any volume,
  as on a stream, but is still when muted, unlike a stream's, which reads
  before the volume and moves when muted. NTS 1 and 2 still use the Web
  Audio analyser.
- **WebView2's audio is in the tree.** WebView2 plays from a sandboxed
  audio-service process under its browser process, which runs under ours.
  On this machine, include-tree capture of headless Edge 155 (the same
  engine and process layout) read a 0.01 oscillator back at a peak of
  0.00999994, and a test tone at 0.0100.
- **Not on a hidden desktop.** Loopback hears silence from a process on a
  hidden desktop: the same tone read 0 there and 0.0100 on the real one,
  in the same run. So on a hidden desktop a pick's visualisation stays
  still, and the moving one can only be checked on a real desktop.
- **Where there is no process loopback** (older Windows, macOS),
  `pick_audio` returns nothing and a pick shows a still visualisation, as
  before.

CPU, % of one core over the whole tree, release build, hidden desktop,
muted, 30 s each: Bars 18.9 on NTS 1 and 23.5 during a pick; Milkdrop
14.8 and 14.7. The pick figures include the widget's own playback. The
capture costs the Rust process 0.5 to 1.2 points.

### Playlists over the skin; a pick links to nts.live (ATA-198, 2026-10-20)

Ata (ATA-163): "a lot of the cases the playlist doesn't really work. I
can't see it." An audit rendered every listed skin with a `<playlist>` in
headless Edge through `tools/skin-preview.mjs`, from the local skin cache,
clicked the skin's own playlist buttons through DevTools input, and
compared the list's pixels with and without its rows. The full table and
screenshots are on ATA-198.

- **The list lies over everything.** WMP's playlist is a window of its
  own, so it sits above every image in the view, whatever its `zIndex` or
  place in the markup. Skins rely on this: 9SeriesDefault's panel bitmaps
  come after its list, HOB's list has `zIndex="-2"`, Plus! Hard Boiled's
  drawer frame covers its list, and 9SeriesDefault hides the list while
  its drawer slides (`onEndMove`). The engine now draws playlists after the
  rest of the view and hit-tests them first. A shown list is part of the
  window shape too: TEDDY's sits in a hole of its drawer.
- **Text colour.** Microsoft's reference gives `foregroundColor` a default
  of the Windows text colour, black, and `backgroundColor` the window
  colour, white. Skins show the second is not what WMP drew: Rusty and
  Science name only white text over dark art. So with no background named
  the art shows through, black where there is none, and with no text
  colour named the engine picks black or white, whichever reads on the
  list's background or the average of the art under it (`textOn` in
  `pixels.ts`). Primitive, Beck, Zengarden and springflower now read.
- **Buttons that could not be clicked.** A button group with no `image`
  took clicks over its whole box, so Cablemusic's close buttons covered
  its drawer tabs; now only its elements do. A button whose image is all
  transparency colour is an invisible hotspot over its box: every control
  of holiday_skin, and Grinch's and Josie's playlist buttons, are drawn
  that way. `playlist.setColumnWidth` now
  does nothing instead of throwing, which stopped TwinBlade's drawer
  script. A boolean that starts with `false` is false:
  The_Doobie_Brothers' button has `down="false; jscript:…"`.
- **Not fixed here.** 47 of the 136 listed skins with a playlist have it
  only in a view the engine never opens; view switching is Mika's call.
  The rest are in `AGENTS.md`, Known gaps.
- **A pick links to nts.live** (Mika, from ATA-197). A double click on a
  pick's title or playlist row opens its episode page on nts.live, the
  page the tray's "Show on nts.live" opens, not SoundCloud (`episodePage`
  in `picks.ts`). A pick without plain-slug aliases has no link.

### Section headers in the playlist; a pick's tags first (ATA-208, 2026-10-21)

Ata: the picks' tags "are currently shown in the playlist after the name,
at the very end… The NTS Picks and the Infinite Mixtapes should be clearly
separated." The request could be read more than one way; Mika chose this
reading.

- **A header row starts each section:** `— NTS Picks —` and
  `— Infinite Mixtapes —`, only when that section has items. A header is an
  `Item` with no url. It never plays: Next and Previous pass over it, and a
  click on it does nothing. The dashes mark it out in every skin.
- **The state message gains `headers`,** the header rows' indexes. The
  skin ignores a press on one, so the current row never moves, even for a
  moment (review round 1).
- **A pick's tags come first:** `<genres and moods> · <name> - <location>`.
  At the end, narrow skins cut them off. This replaces the title format of
  ATA-197, below. The Winamp app's `picks.ts` keeps the old format.

### Picks before mixtapes; no SoundCloud credit or name (ATA-197, 2026-10-20)

Reverses the pick credit of ATA-115 and the playlist order and pick titles
of ATA-113, below.

- **Ata drops the SoundCloud credit** (ATA-163): "I don't want to see
  SoundCloud… I take the risk if SoundCloud sues me or sends me an angry
  email." SoundCloud's API terms ask for the uploader and SoundCloud to be
  credited with a link back. Ata owns the project and accepts that risk.
  The standing rule to credit SoundCloud uploaders is withdrawn.
- **Gone:** the `credit` webview (`credit.html`, `src/credit.ts`, its
  capability), the `credit`, `credit_size` and `open_credit` commands, the
  credit's rectangle in the window's shape, the tray's credit entry, and
  the widget's `getCurrentSound` call, which only fetched the uploader's
  name. `now_playing` no longer takes a `credit`.
- **A pick's title is the episode's,** from the picks API: `<name> -
  <location> (<genres and moods>)`, with no uploader and no "on
  SoundCloud". Its Author is empty. SoundCloud's widget still plays it,
  hidden, and the tray's "Show on nts.live" still links to the episode.
  A double click on the title still opens the track's page, as before
  (ATA-198 points it at the episode on nts.live);
  that link shows no SoundCloud text in the app.
- **The playlist is NTS 1, NTS 2, the picks, then the mixtapes** (Ata,
  ATA-163). The picks keep the API's order, newest first. `playlist()` in
  `player.ts` builds it, once both APIs have answered or failed; next,
  previous, the tray, the media keys and the playlist all index that one
  list, and the channels keep indexes 0 and 1.

### Previews in the skin picker (ATA-193, 2026-10-19)

Reverses ATA-112's "No preview images" below. Ata asked for a preview of
the skin selected in the picker.

- **One click selects, "Use this skin" or a double click wears.** The
  picker gained a pane beside the list. Selecting a skin shows it there:
  from the cache straight away, or downloaded once into the cache, so
  wearing it afterwards downloads nothing. That is one download per
  selection of a skin not cached, never ahead of time and never in bulk.
  `skins::fetch` lets one caller at a time fetch a given skin; a second
  (a double click, or "Use this skin" while the preview downloads) waits
  and then reads the cache. A failed download, or a skin the engine cannot
  load, says "No preview"; another click on it tries again, and the list
  stays usable.
- **The preview is the engine itself, scripts and all,** in a `preview`
  webview: a child of the picker window, on the `skin` protocol, which no
  capability names, as the `skin` webview. Running the scripts draws skins
  sized by `jscript:` (Classic) as they are worn; a static first view would
  not. Rust serves it the engine and the selected skin and drops every
  message it sends except `shape`, which sizes the preview: no play, no
  window moves, no links. It has no house-skin fallback; asking for one
  means "No preview". Each selection loads the page as
  `/?preview=<id>`, and Rust ignores requests whose `Referer` names an
  earlier selection, so a late page cannot answer for the current one.
  Rust zooms the webview (WebView2's zoom factor) so the box around the
  skin's opaque runs fits the pane, never above 100 %, crops the view to
  that box, and centres it. It shows the webview only once the selected
  skin has drawn, a resize or restore of the picker included. The picker
  page tells Rust where the pane is (`preview_area`, whenever `<main>`
  changes size); it still runs no skin code and gains only that and
  `preview_skin`.
- **No thumbnails.** A cached skin draws in about 0.3 s, so nothing is
  saved but the `.wmz` the cache already keeps.

Checked on a release build on a hidden desktop, behind `tools/proxy.mjs`
for Rust's downloads (`HTTPS_PROXY`), with clicks sent through DevTools:
- **Cached** (bluegrid, anemone, Headspace): the preview showed 250 to
  290 ms after the click.
- **Not cached** (amped2, 807 KB): the proxy logged one download, a tunnel
  to archive.org for the redirect and one of 812 KB to its data host; the
  preview showed after 4.1 s. "Use this skin" then wore it with no new
  tunnel, and `skin.json` named it. A double click on bluegrid wore it.
- **archive.org cut** at the proxy, with Headspace moved out of the cache:
  Headspace said "No preview" after 1.0 s (both tries refused), and anemone,
  cached, previewed in 0.29 s.
- **Isolation:** `tools/escape.mjs <port> preview` gives the same rows from
  the preview webview as from the skin webview: every command refused by
  the ACL, `preview_skin` and `preview_area` included, no IPC reached the
  skin, the CSP blocked the remote fetch and both frames, navigation stayed
  on `skin.localhost`. `minimize`, `drag` and `picker` posted from the
  preview changed nothing.
- **After review** (same setup; the window resized with `SetWindowPos`): the
  pane followed the picker from 1016 to 816 to 1216 px wide. "No preview"
  stayed after a resize, with the webview hidden. A double click on
  uncached Goo downloaded it once and wore it. 80 pairs of clicks on two
  cached skins, 4 to 60 ms apart, each ended on the second skin drawn and
  no "No preview". 9SeriesDefault fills the pane, cropped to its player.
- Not tried: a real mouse, and resizing the picker by hand.

### Tiled sliders keep their end caps (ATA-192, 2026-10-19)

- **Headspace's EQ drew a cap, a stub, a cap.** Its sliders set
  `tiled="true"` and `borderSize="7"` on a 15 px `vertical_slider.bmp`: 7 rows
  of metal cap, one row of green bar, 7 rows of cap. The engine repeated the
  whole image down the 76 px slider.
- **The rule, from Microsoft's `SLIDER.borderSize` page:** with `tiled` on,
  the first and last `borderSize` px of the image along the slider are its
  end caps, drawn once at each end; only the middle repeats. `tiles()` in
  `pixels.ts` lays the copies out, and its test uses Headspace's numbers. An
  image too short to hold both caps (sankofa's 2 px EQ image with
  `borderSize="7"`) repeats whole, as before. The page names the
  background image; the engine treats a tiled foreground the same way, since
  it fills the same track.
- **Stretched sliders are unchanged.** The page ties the caps to tiling
  only, so a slider without `tiled` still stretches its whole image.
- **What changed:** among the working skins, only tiled sliders with a
  `borderSize`, an image longer than both caps, and an image length that
  differs from the slider's draw differently: Headspace, iMusica, iconic,
  Faith, and one slider each in Primitive and Plus! Aquarium. An image
  exactly as long as its slider comes out pixel for pixel as before
  (Miniplayer, Vario, Canvas and 9SeriesDefault). Nautical's seek slider
  sets both attributes but has no image. Release-build screenshots of
  bluegrid, Classic, anemone and the house skin match `main` pixel for pixel
  outside the visualisation, title and clock, which move; none of them has
  such a slider.
- **Not changed:** the same page says `tiled` defaults to true; the engine
  defaults it to false. Switching would change many skins at once, so that
  is left for an issue of its own if a skin shows it.

### The app always opens unmuted (ATA-196, 2026-10-20)

- **Mute no longer survives a restart.** Ata's app opened silent two days
  running: it was still muted from ATA-194, and the visualiser kept moving
  because it reads the stream before the volume. Mika decided the app
  always opens unmuted; volume, balance and EQ are still remembered.
- **The saved `mute` is ignored on load** (`src/settings.ts`). It is still
  written, which is harmless and keeps the change to one line.

### Mute in the tray (ATA-194, 2026-10-19)

- **Ata's app went quiet because it was muted.** Mute was remembered across
  restarts (no longer, since ATA-196), and 9SeriesDefault's mute button (`bMute`) sits among Play,
  Stop, Next and Previous, easy to hit and hard to spot.
- **The tray has a Mute check item.** It toggles the same setting a skin's
  mute button sets, in the trusted page, and `now_playing` checks it from
  that setting, so the skin and the tray follow each other.
- **The tray's tooltip says "(muted)".** One place only; the media overlay
  is unchanged. A long title is cut before the suffix, never the suffix.
- **The engine needed no change.** `bMute` is sticky, its `down` bound to
  `wmpprop:player.settings.mute`, and its `onClick` sets `mute=down`: the
  engine flips `down` before `onClick` reads it, then follows the setting
  again. Checked on a release build on a hidden desktop: a click shows the
  down image and mutes, a second click unmutes, and after the tray mutes the
  button shows down and a click unmutes. The tray was stood in for by its
  `tray` event; nobody has clicked the native menu yet.

### NTS accounts: a link to the show, no sign-in (ATA-168, ATA-172, 2026-10-14)

- **The app cannot follow or save shows itself** (ATA-168). NTS's writes go
  through Firebase App Check, which accepts only nts.live's own clients, and
  nts.live has no sign-in that hands a token to another app.
- **So the tray links to the show's page** (Mika's choice). "Show on
  nts.live" opens `https://www.nts.live/shows/<show_alias>` for a channel,
  from the live API's `details.show_alias`, and
  `/shows/<show_alias>/episodes/<episode_alias>` for a pick. The listener
  follows or saves it there, signed in in their own browser. The entry is
  gone for a mixtape, and whenever the API gave no alias. No login, token
  or account code; no new capability.

Checked on a release build on a hidden desktop, with a probe (not
committed) that logged the tray's entries after each `now_playing`: NTS 1
opened `/shows/touching-bass`, NTS 2 `/shows/james-k`, the pick Milkweed
`/shows/milkweed/episodes/milkweed-7th-october-2026`, with the credit
below it; a mixtape had no entry. With `www.nts.live` mapped to nothing,
neither channel had one, and NTS 1 played.

### Sliders that seek from onMouseUp (ATA-170, 2026-10-14)

- **Sliders fire `onMouseUp`** when a drag ends, after `onDragEnd`
  (`onMouseDown` already fired on every element). Kenwood_MP7, portals,
  QuantumRedshift, TwinBlade and MotherLand seek only there
  (`player.controls.currentPosition=<slider id>.value`), on sliders that
  are not bound to `currentPosition`.
- **A slider bound to nothing keeps the value it was dropped at,** as in
  WMP, so those seek bars' thumbs stay put. Sliders bound to the player
  (a `wmpprop:` or `jscript:` value, or a volume, balance or seek slider)
  go back to the player's value.
- **Still one drag, one seek.** The engine seeks only for a seek slider, and
  only if neither `onDragEnd` nor `onMouseUp` sent one: anime's
  `onMouseUp` seeks, so the engine does not.
- **Streams stay unseekable.** Such a slider runs from 0 to
  `currentMedia.duration`, which is 0 on a channel or mixtape, and setting
  `currentPosition` there sends nothing.

Checked on a release build on a hidden desktop (`--mute-audio`), through
DevTools input events. During a pick, a drag on QuantumRedshift's seek dial
moved the widget from 14 s to 2876 s, and one on TwinBlade's position bar
from 7 s to 3155 s. Both kept playing, and each drag sent one `seek`. On
NTS 1 the same drags sent none. Kenwood_MP7's bar could not be tried: its
`mainMeta` subview is not drawn or hit, a separate engine bug.

### A seek bar for picks (ATA-165, 2026-10-14)

- **A pick has a length.** The widget's `getDuration` gives it, asked when
  the pick is ready and again when it starts if it read 0; `playProgress`
  gives the position, as before. The state message's `duration` is the
  pick's length in seconds, and still 0 for channels and mixtapes.
  `currentMedia.duration` and `durationString` read it, and a seek slider
  runs from 0 to it.
- **Clocks over an hour read `H:MM:SS`**, as WMP's do: `1:58:00`, not
  `118:00`. Under an hour they stay `MM:SS`.
- **Seeking.** During a pick, a `seekSlider`, or any slider bound to
  `player.controls.currentPosition`, is enabled. It sends `seek` once, when
  the drag ends, after the skin's `onDragEnd`, and only if that handler sent
  none: Classic's sets `player.controls.currentposition=value` and seeks
  itself; Television's and anime's misspell it (`currentpostion`) and send
  nothing, so the engine seeks. One drag, one seek. A script setting
  `currentPosition` seeks too. The trusted page passes it to the widget's
  `seekTo`, clamped to the pick. Rust drops a `seek` outside 0 to 86,400 s.
- **Channels and mixtapes stay unseekable.** Their `duration` is 0, so the
  slider is disabled and a `seek` does nothing. Fast forward and rewind
  stay disabled for everything.
- **Only the loaded pick has a clock.** Next or Previous while paused
  moves to another item but keeps the last pick loaded, so it can resume.
  Until the new pick loads, it reports time and length 0 and does not seek.
- **A paused pick shows its time.** A paused stream still shows none,
  since pausing drops it.
- **The house skin** has no seek slider. Its clock reads
  `1:02:34 / 1:58:00` during a pick, at 10 pt instead of 13 pt so it fits.

Checked on a release build on a hidden desktop (`--mute-audio`), through
DevTools: on the house skin a pick showed `00:08 / 2:00:09`, and setting
`currentPosition` to 3600 from the skin webview put the widget at 3605 s
five seconds later, still playing. On bluegrid (`seekSlider`) and Classic
(a slider with `onDragEnd`) a mouse drag along the bar moved a pick to
1736 s and 3778 s; the position read back from the widget kept counting
from there. Back on NTS 1 the slider was disabled and `duration` 0.
`tools/escape.mjs` gave the same results as ATA-107.

### Which channel is playing (ATA-164, 2026-10-14)

- **Title:** `NTS 1: <show> - <location>` (was `NTS 1 - …`). Skins like
  circle print the show before the title, dashes between, so the channel
  got lost in the middle of a run of names. Mixtapes and picks
  keep their own titles. The tray tooltip and Windows' media overlay use the
  same text.
- **Playlist:** the current row is drawn in the skin's `itemPlayingColor`
  and `itemPlayingBackgroundColor`. 24 of the 30 working skins with a
  playlist in their first view name neither, so their current row gets the
  list's own colours swapped: the foreground colour as its background, the
  background colour as its text.
- **Tray:** NTS 1 and NTS 2 are check items, the current channel checked;
  neither while a mixtape or pick plays, since the tray lists neither.
  Windows flips a check item's mark on every click, so a click sets both
  marks again at once.

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
- **A pick's credit belongs to the app** (removed by ATA-197, above). While a pick plays and is not
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
  (ATA-197 puts the picks before the mixtapes.)
  Next and previous walk the whole list and wrap; a playlist row sends the
  new `select` message rather than a run of `next`s, which would reload a
  stream at every step. The app still opens on NTS 1.
- **Titles.** A channel's title is `NTS 1: <show> - <location>`, the
  channel first as in the Winamp app (Ata, 2026-10-09; the colon is
  ATA-164's). That is
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
  it, and that credit is also its Author. (Reversed by ATA-197: no credit.) A double click on a text showing
  `currentMedia.name` (or its title or author item info), or on the pick's
  own playlist row, opens the track page through `launchUrl`. A double
  click, not a press, so pressing the title still drags the window. A pick that does not start within 15 s, or that the
  widget reports an error for, stops the player; a stuck pick is not
  reloaded, since that would start a two-hour mix over; a finished pick
  moves on to the next item. Pause keeps a pick's place. Picks report no
  duration, so skins treat them as live (no seeking) for now. (Reversed by
  ATA-165: picks have a length and seek.)
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
- **Remembered:** volume, balance and the EQ, in the trusted page's
  `localStorage`, clamped on load. Mute was too, until ATA-196. The skin came later, with ATA-112: a
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
| `{ "type": "seek", "seconds": 0..86400 }` | the trusted page: seeks a pick, clamped to its length; ignored for live streams (ATA-165) |
| `{ "type": "drag" }` | Rust: moves the window with the pointer, only while our window is in front and under the pointer with the button down |
| `{ "type": "shape", "width", "height", "rects": [[x, y, w, h], …] }` | Rust: sizes the window and sets its region. Ignored unless the view is 1–4096 px a side and every run is non-empty and inside it, with at most ceil(width / 2) runs per row |
| `{ "type": "close" }`, `{ "type": "minimize" }` | Rust: closes or minimizes the window (ATA-110) |
| `{ "type": "launchUrl", "url": "…" }` | Rust: opens the URL in the default browser, only if it parses as http(s), is at most 2048 characters, and comes 3 s or more after the last one (ATA-110) |
| `{ "type": "picker" }` | Rust: opens the skin picker, unless it is open already or one opened in the last 3 s (ATA-112) |
| `{ "type": "effects", "on": true \| false }` | the trusted page: whether a visualisation is on screen, so wants analyser frames (ATA-114) |
| `{ "type": "effectsMenu", "effect": n }` | the trusted page: shows the visualisation menu with effect `n` checked, unless one is open already (ATA-190) |

Host to skin: the trusted page calls the `skin_send` command, and Rust
dispatches a `message` event in the skin webview. Today that is, four times
a second (ATA-109):

    { "type": "state", "playState", "channel", "title", "url", "author", "location",
      "link", "items", "time", "duration",
      "volume", "mute", "balance", "eq", "level", "covered" }

`playState` is `playing`, `buffering`, `reconnecting`, `paused` or
`stopped`. `duration` is 0 for a live stream, as in WMP: a skin shows its
seek bar disabled. For a pick it is its length in seconds (ATA-165).
`volume`, `mute`, `balance` and `eq` (ten gains in dB) are the current
settings. A skin's controls start where the listener left them, except
mute, which always starts off (ATA-196).
`covered` is true while other windows hide the player (ATA-122's
`win32::watch_cover`); scrolling text stops then (ATA-191).

From ATA-114, also 20 times a second (30 before ATA-122) while the skin
shows a visualisation, no other window covers the player, and the stream
plays:

    { "type": "vis", "bars": [32 × 0..255], "wave": [96 × 0..255], "pcm": [1024 × 0..255] }

`pcm` is for Milkdrop (ATA-167); a pick's flat frame has none.

From ATA-190, the effect picked in the visualisation menu, by its index in
`EFFECTS` (`effects.ts`):

    { "type": "effect", "index": n }

ATA-166's `show` message (the show card) is gone since ATA-190. From
ATA-200, the show's picture for Album Art, when it changes and after each
skin's first `effects` message; `image` is null when there is none:

    { "type": "art", "image": "data:image/jpeg;base64,…" | null }

The skin also gets `GET /` (the engine page), `GET /engine.js` (the
engine), `GET /milkdrop.js` (Butterchurn and its presets; ATA-167),
`GET /skin.wmz` (the skin itself, whole) and `GET /house.wmz` (the
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
  per user, with no administrator rights. 1.60 MiB for 0.1.0 with ATA-115's
  tray, single-instance and window-state, against 2.23 MiB for the Winamp
  app's 0.1.2.
- **The updater uses SChannel**, as ureq does for skins:
  `default-features = false, features = ["native-tls"]`. Its defaults pull
  in rustls, ring and zip; zip isn't needed, since with
  `createUpdaterArtifacts: true` the signed artifact is the `-setup.exe`
  itself. That took the installer from 1.98 to 1.54 MiB before the ATA-115
  merge (Tirci Lama's review). Like ureq, it does not read Windows' proxy
  settings: `system-proxy` would not resolve next to ureq.
- **The whole update was tried before the first tag**, on a fresh runner
  with a throwaway key: a 0.1.0 and a 0.1.1 built from this branch, the
  0.1.1 installer and its `latest.json` served from `raw.githubusercontent.com`
  (a real certificate, like GitHub's release downloads). The installed
  0.1.0 updated itself to 0.1.1 within 5 s of launch, restarted and played.
  Against `https://localhost` with a self-signed certificate in the
  machine's root store the check failed ("error sending request") before
  the server saw a request, so a local trial needs a real certificate. A
  self-update saves the window position first: the installer ends the app
  without the exit that saves it.
- **Updates install on launch, without asking.** A release build checks
  `releases/latest/download/latest.json` once at startup; if it is newer,
  it downloads, installs in passive mode (a small progress window) and
  restarts. The stream drops for a few seconds. Offline or with no release,
  it plays on and tries next launch. Debug builds never check.
- **Only release builds know where to look** (ATA-204). The updater's
  endpoint is in `tauri.release.conf.json`, which only the release
  workflow passes, so a local `npm run tauri build` has none: its check
  fails at once with "Updater does not have any endpoints set", and it
  never installs over the installed copy. Before this, a local 0.2.3
  build updated itself to v0.2.4 over Ata's installed copy and closed it
  (ATA-199).
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
  playing, which is one connection to a radiomast audio edge held for 15 s
  (an edge known by its reverse name or by an address `streams.radiomast.io`
  redirects to: v0.1.0's run met one named after a hosting provider);
  the skin it downloaded, whose md5 must be a working one in
  `compatible.json` (or, if archive.org delivered none, the house skin,
  which the run flags with a warning); two shots of the window 15 s apart; then a silent
  uninstall that must leave no install folder, no Settings > Apps entry
  and no shortcuts. It then installs the release before and waits for it to
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

| Skin, playing | Before | After | After, merged with ATA-115 (one run) |
|---|---|---|---|
| Classic, no visualisation | 9.5–11.9 | 6.1–6.9 | 5.3 |
| anemone, Bars | 28.6–41.5 | 24.3–28.1 | 34.6 |
| Halloween, Bars and a scrolling title | 39.7–49.5 | 30.3–30.4 | 37.3 |
| Bootleg House, Bars and a title scrolling every 40 ms | 36.4–43.3 | 27.9–40.4 | 31.6 |
| The Winamp app 0.1.2, its spectrum showing | 12.7–22.5 | | |
| The Winamp app 0.1.2, its visualiser clicked off | 5.7 | | |

What is left is mostly the frames' trip, not the drawing. Stopping the
frames on Bootleg House took it from about 30 % to 15 %, though each frame
now redraws a few thousand pixels: each of the 30 frames a second is an IPC
call from the trusted page to Rust, then a script evaluated in the skin
webview, then a composite of both webviews. The house skin also repaints in
full 25 times a second for its title. RAM, playing, on the merged build:
290–310 MB private (560–610 MB working set, which counts shared pages more
than once), against 280 MB (540 MB) for the Winamp app.

## Skins

### The playlist like WMP's: scroll bar, colours, long names (ATA-191, 2026-10-19)

Ata, on v0.2.1 with Headspace next to pictures of it in WMP: WMP's list has
a scroll bar, its playing row is green, and long show names are cut off.

- **The green is WMP's default, not Headspace's.** Headspace's `<playlist>`
  names only `backgroundColor="#285F03"` and `foregroundColor="white"`.
  Microsoft's reference gives `itemPlayingColor` a default of `#00FF00` and
  `itemPlayingBackgroundColor` `#222222`, and archive.org's one picture of
  Headspace in WMP (`headspace.png`) shows exactly that: green text on a
  near-black row. The engine used to swap the list's own colours when a
  skin named neither. Now each colour the skin leaves out takes WMP's
  default (`playingColors` in `pixels.ts`). Selection colours
  (`itemSelected*`) are not used: a click here plays the row, so the
  selected row is the playing one.
- **Other skins.** The cached skins hold 223 `<playlist>` tags. 99 name
  both colours, the house skin and The Skins Factory's among them, and do
  not change. 9 name only the text (circle, Nautical, Sports, Spider-man,
  HOB, Jaws and three more): WMP's `#222222` row now sits behind it. 6
  name only the background (elvis and four Plus! skins): their text turns
  green. The other 109, Headspace among them, look like Headspace.
- **The scroll bar** is drawn by the engine, 16 px wide (Windows' own is
  about that at 96 dpi), only when the rows do not all fit. It has no
  arrows and uses no images of WMP's: a track and a thumb mixed from the
  list's background and text colours (15 % and 55 % of the way to the
  text). The thumb's length is the share of rows in sight, never under
  8 px. Dragging it scrolls, a press on the track pages by a screenful,
  and the wheel scrolls by a row as before (`thumb` and `firstAt` in
  `pixels.ts`).
- **Long names.** The playing row's name scrolls right to left when it is
  wider than the row, by the same code and timer as a `scrolling` text
  (1 px every 100 ms unless the list names `scrollingAmount` or
  `scrollingDelay`). It starts from the first word whenever the playing
  row or its name changes. Other rows are cut off, as before. A press on
  the scroll bar disarms the pick link, so a double click there never
  opens SoundCloud.
- **Covered or minimised.** The state message gains `covered`, Rust's
  existing cover check passed on by the trusted page. While it is true,
  no scrolling step is scheduled, for the playlist or any `scrolling`
  text; uncovered, the next state repaints and they move again. Minimised,
  Rust already hides the webviews, which stops them.
- **Release build, hidden desktop.** Headspace: a scroll bar and the green
  row; NTS 1's long title moves between two captures a second apart. A
  drag on the thumb through DevTools input scrolled to the last picks; a
  click on one played it, and its name scrolled on the green row. The
  house skin keeps its own orange row and gains the bar. bluegrid has no
  playlist and is unchanged. `tools/escape.mjs`: every skin-side attempt
  still fails as before.

### Milkdrop on a small preset budget (ATA-167, 2026-10-14)

Ata asked for Milkdrop in the skins' visualiser area. ATA-114 left it out
on size; this adds it within a budget of 1.5 MB on the installer.

- **What.** Butterchurn 2.6.7 (MIT, Jordan Berg) and the 29 presets of its
  "minimal" pack (`butterchurn-presets` 2.4.7, MIT; Jordan Berg picked
  them). Each preset's name credits its MilkDrop authors: Geiss, Flexi,
  Martin, Rovastar, Unchained, Zylot, Krash, Illusion, Idiot, suksma, yin,
  Eo.S., Phat, AdamFX, QBikal, fishbrain, Mig, $$$ Royal and FED. The
  README credits them, and the served file starts with the MIT notice. No
  preset needs an image beyond Butterchurn's built-in noise.
- **Where it renders: in the skin webview.** The other choice was an
  app-owned webview over the `effects` rectangle, as the pick credit is.
  That webview would need the audio too (it lives in the trusted page
  either way), would cover whatever a skin draws over its visualisation
  (anemone's pods), and would have to follow the area as scripts move and
  hide it. In the skin webview, Milkdrop is one more effect: the engine
  draws it under the skin's cover like Bars (ATA-116), and the
  hidden/covered/minimised rules that stop frames stop it too.
- **Isolation.** Nothing new reaches the skin. The skin protocol serves one
  more fixed file, `GET /milkdrop.js` (Butterchurn and the pack, straight
  from `node_modules`, built into the binary). The CSP is unchanged: the
  file is `'self'`, and Butterchurn compiles the presets' equations with
  `new Function`, which `'unsafe-eval'` already allowed for `jscript:`.
  Butterchurn runs with no `AudioContext`: each `vis` frame now also carries
  `pcm`, the newest 1024 samples of the trusted page's analyser, and
  Butterchurn reads its bass, mid and treble from those. A skin's script
  shares the webview with Butterchurn as it already does with the engine,
  so it can tamper with it, but gains nothing it could not do before.
  `tools/escape.mjs` on the release build gives the ATA-107 rows.
- **Lazy.** The engine adds `<script src="/milkdrop.js">` the first time
  Milkdrop has a frame to draw; until it loads the area is the background
  colour. Without WebGL 2 it stays that colour and logs why.
- **The cycle.** "Milkdrop", presets 0 to 28, after Ambience (and, until
  ATA-190, before the show card). As in WMP, `next()` walks an effect's
  presets before the next effect, so `next` within Milkdrop moves to the
  next preset, and after the last one round to Bars. A new preset blends in over a second. The choice
  is saved like the others (`mediacenter.effectType` and `effectPreset`).
- **Frames.** Butterchurn renders once per `vis` frame, 20 a second
  (ATA-122), into a WebGL canvas of the area's size, copied to a 2D canvas
  for repaints between frames. No frames (paused, hidden, covered,
  minimised) means no rendering. A pick's flat frame has no `pcm`, so
  Milkdrop shows the background colour during a pick, as Bars and Scope
  show flat.

Installer, release builds of `main` (`78538fc`) and this branch:
1,677,765 bytes before, 1,746,021 after (+67 KB, 1.60 to 1.67 MiB). The exe
grows 387 KB (4.53 to 4.92 MB): the two files are stored uncompressed in
it.

CPU, % of one core over the whole process tree, release builds, anemone,
NTS 1 playing muted on a hidden desktop, 30 s samples, two per launch,
launches interleaved; the machine was busy with other work:

| | Samples | Median |
|---|---|---|
| `main`, Bars | 20.9, 18.5, 19.2, 24.7 | 20.1 |
| This branch, Bars | 24.8, 22.4, 22.3, 13.5, 26.1, 22.4 | 22.4 |
| This branch, Milkdrop preset 0 | 31.9, 29.7, 30.1, 26.6, 36.8, 33.1 | 31.0 |
| This branch, Milkdrop preset 18 (mandelbox explorer) | 23.4, 21.1 | |
| This branch, Milkdrop preset 5 (alien fish pond) | 21.0, 17.8 | |

Milkdrop costs about 0 to 9 points of a core over Bars, under the 15 the
issue allows, so it keeps the 20 frames a second. Bars may cost a point or
two more than on `main`, for the 1024 samples each frame now carries; the
spread is wider than that.

### The visualisation menu; the show card goes (ATA-190, 2026-10-19)

Ata, on v0.2.1: the visualiser should show only visualisations, no text or
pictures; show titles belong in the playlist. And clicking through 29
Milkdrop presets one at a time is slow. This reverses the show card
(ATA-166, below).

- **The card is gone.** The "NTS show" effect, its drawing and layout, the
  `show` message and the trusted page's picture fetch are deleted (the
  fetch is back since ATA-200), with
  what only they used: the live API's genres, the mixtapes' pictures (back
  since ATA-200) and
  bare titles, the picks' bare names and tags (`name`, `tags`). The
  playlist and the title never used those: they show each item's full
  `title`, as before ATA-166. The pick's picture stays, for the overlay.
- **Default and fallback.** The first launch shows Bars again, as before
  ATA-166 (Album Art since ATA-200). The choice is still saved (`mediacenter` in the skin webview's
  `localStorage`); a saved effect the list does not have, such as "NTS
  show", reads as Bars, so a skin bound to `mediacenter` sees Bars too
  (Album Art since ATA-200).
- **The menu.** As in WMP, a right click on the skin's `effects` area opens
  a menu: Bars, Scope, Ambience, and a Milkdrop submenu with the 29 presets
  by name (Butterchurn's names, `PRESETS` in `milkdrop.ts`; a test checks
  them against the pack). The current one is checked. Picking one shows it
  and saves it as `next()` does. A right click anywhere else still opens
  the skin picker. Clicking the area and the skin's own next and previous
  controls still step through the list.
- **Isolation.** The skin only asks: it sends `effectsMenu` with the index
  it shows. The trusted page builds the native menu with Tauri's menu API
  (`core:default`, which only the trusted page's capability names) and
  sends back `effect` with the index picked. The skin never names the
  entries, so it cannot put its own text in the menu. The trusted page
  shows one menu at a time; like the picker, a skin can send
  `effectsMenu` itself and open the menu, nothing more. `tools/escape.mjs`
  now also tries the menu plugin from the skin: `Command plugin:menu|new
  not allowed by ACL`.
- **Release build, hidden desktop.** anemone and bluegrid show Bars on a
  first launch; 33 `next()` calls on bluegrid step through 32 effects and
  never reach a card. A right click on anemone's area lists all 33 entries
  (read back from the open menu); picking Milkdrop preset 10 shows it, and
  after a relaunch bluegrid shows it and the menu has it checked. A saved
  "NTS show" opens on Bars. A right click on anemone's frame opens the
  picker, not the menu. The menu was driven with key messages posted to
  its window on that desktop; nobody has clicked it with a real mouse.

### The NTS show card (ATA-166, 2026-10-14; reversed by ATA-190)

Ata asked for the show's picture and genres, as nts.live shows them, in the
skin's visualiser area. A fourth effect, **NTS show** (`effectType` "NTS
show", preset 0), draws the show's picture cropped to fill the area, and
over it, on a dark band, the show's title (two lines at most) and up to
four genres as outlined tags. It joins Bars, Scope and Ambience in
`next()` and `previous()`.

- **Data.** The live API's `now.embeds.details.genres[].value` and the
  `media.picture_small` (200×200) that `live.ts` already read for the
  overlay. On 2026-10-14 NTS 2's show had no genres: the card then has none.
  A mixtape uses its own `media.picture_small` and its title without the
  subtitle (both now read by `mixtapes.ts`). A pick uses the NTS episode
  picture the picks API gives, the one the overlay already shows, its name
  as the title and its genres and moods as tags (`picks.ts` now keeps them
  apart). SoundCloud's widget has the track's artwork too, but the NTS
  picture is already at hand.
- **Isolation.** The skin's CSP is unchanged. The trusted page fetches the
  picture (`media*.ntslive.co.uk` sends `Access-Control-Allow-Origin: *`)
  and sends it to the skin as a `data:` URL in a `show` message through
  `skin_send`; the skin CSP already allows `data:` images. Rust is not
  involved. It is sent when the item or the show changes, and again when a
  skin starts: the engine now always sends one `effects` message on its
  first paint, and the trusted page answers that with the card. A picture
  that fails to load or decode leaves the card without one.
- **Fallbacks.** Without the API, the card shows the item's title ("NTS 1")
  on the element's background colour, in its foreground colour (white if
  none). Playback never waits for any of it.
- **CPU.** The card is drawn once per card and area size, then copied. The
  skin tells the trusted page that a card needs no analyser frames
  (`effects` `on: false`), so none are sent. Release build, anemone, NTS 1
  playing, muted, 30 s each: card 5.9 and 5.5 % of one core, visualisation
  hidden 5.5 %; in an earlier run Bars took 29.4 %. The reviewer's three
  alternating pairs on one running app gave card 8.8, 9.6, 7.6 % against
  hidden 7.4, 6.5, 5.0 %: about 2 points. Likely the cause: while any
  visualisation shows, each full paint (once a second for the clock) draws
  the view twice and reads back its pixels to find what covers it
  (ATA-116); a hidden one skips that.
- **Saved.** `mediacenter.effectType` and `effectPreset` are now kept in
  the skin webview's `localStorage`, so the effect is the same on the next
  launch and in other skins. Skins that bind their `effects` element to
  `mediacenter` (anemone, bluegrid, cerulean) read it from there; an element
  with no `currentEffectType` (the house skin's) shows `mediacenter`'s, and
  `next()` saves to it. Before any choice, it is the card.
- **Layout.** The text goes where the skin leaves it clear. A full paint
  already works out how much of the area shows at each pixel (`overlay`,
  ATA-116); when the card is drawn, `clearRows` takes each row's widest
  fully shown run, and `place` finds the band whose rows share the widest
  span, nearest the middle. The card tries the widest text first and
  narrows it until it fits such a span; if the genres would leave the title
  narrower than about 6 characters' width, it drops them. The house skin's
  round area and anemone's (its whole window, pods over two corners) keep
  the title and lose the genres; bluegrid keeps both. The layout is redone
  for a new card or size, not when the cover changes.

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
  none; picking one puts it on the window. (ATA-193 added previews drawn by
  the engine; see above.) "A random skin on every launch"
  also puts a new random skin on at once, so the choice shows.
- **No preview images** (Mika for Ata, 2026-10-11; reversed by ATA-193,
  above, which draws them live instead). The issue asked for
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

### Visualisation frames: 20 a second, none while covered (ATA-122, 2026-10-14)

The cheap follow-up to ATA-116's CPU finding (its option 2; v0.1.x shipped
as it was). How frames reach the skin webview is unchanged: still
`skin_send`, the ATA-107 boundary.

- **20 frames a second, not 30.** The trusted page sends a frame when 45 ms
  have passed since the last: every third display frame at 60 Hz, every
  sixth at 120 Hz (50 ms); 18–19 a second at 75 or 90 Hz. Measured in the
  skin webview, release build, anemone: frames arrive every 50.0 ms (p95
  51.1 ms, worst 51.7 ms), as evenly as 33.3 ms (p95 34.3 ms) did before.
- **The look per second is kept.** Bars' peak caps fall `h / 33` a frame
  instead of `h / 50`, and Ambience's trails fade by 0.175 a frame instead
  of 0.12, so both move as fast per second as they did at 30 frames.
- **None while covered.** WebView2 is not told when other windows hide the
  player, so Rust looks four times a second (`win32::watch_cover`): it
  walks the windows above the player and subtracts each one that hides what
  is behind it from the player's rectangle. When nothing is left it emits
  `covered` to the trusted page, which stops sending frames until the
  player shows again. It errs towards "not covered": translucent,
  colour-keyed, click-through, shaped, minimised and cloaked windows hide
  nothing, and a window DWM cannot measure, ours included, covers nothing
  either. Rectangles are DWM's visible bounds, without the invisible resize
  borders; the player counts by its whole rectangle, not its shape. The
  visualisation keeps its last frame while covered and moves again within
  half a second of being uncovered (the poll, then the trusted page's state
  tick). Two ways it can still freeze while something shows: an overlay
  that draws through DirectComposition without the layered style counts as
  opaque, and Windows 11's rounded corners leave a few pixels of the player
  visible when a window exactly covers it.
  On a hidden desktop, anemone: 20 frames a second with nothing over it and
  with a window over half the screen (the player partly under it), 0 under
  a maximised window (6.6 % of a core, against 26.6 % uncovered in the same
  run), 20 again once that window closed. The old build kept 30 frames a
  second under the same window.

CPU, % of one core over the whole process tree, release builds, Bars
showing, playing muted (`--mute-audio`), on a hidden desktop. Two launches
of each build, interleaved, two 30 s samples each, so four samples a cell;
the machine was busy with other work throughout, so the spread is wide.

| Skin, playing | Before (30 frames) | After (20 frames) |
|---|---|---|
| anemone | 24.6–32.9, median 31.3 | 9.1–17.6, median 15.8 |
| Halloween | 26.5–34.0, median 27.2 | 16.5–27.7, median 22.8 |
| Bootleg House | 29.0–49.4, median 34.4 | 26.6–35.4, median 32.4 |
| The Winamp app 0.1.2, its spectrum showing | 10.9–26.4, median 18.4 | |

Bootleg House gains least: it repaints in full 25 times a second for its
scrolling title, whatever the visualisation does.

### Visualisations: our own bars, scope and ambience (ATA-114, 2026-10-11)

An `<effects>` element draws one of three visualisations of our own, after
the look of WMP's: **Bars** (32 log-spaced spectrum bars, 40 Hz to 16 kHz,
with falling peak caps), **Scope** (the waveform) and **Ambience** (soft
coloured lights that drift and swell with the music). Nothing is copied from
WMP or from the GPL WMP 8 clone. `src/skin/effects.ts` has them.

- **Data.** The trusted page reads a second analyser, tapped from the stream
  before the volume, so the visualisation moves at any volume and when
  muted, as WMP's does. It has 8192 points (6 Hz bins), so the lowest bars,
  8 Hz apart, each read their own bin. 20 times a second (ATA-122) it sends
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
  across launches (it is since ATA-166, and the first launch shows Bars
  again since ATA-190, Album Art since ATA-200).
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
- **Milkdrop (Butterchurn): not added** (added since, on a small preset
  budget: ATA-167). The `butterchurn` package is
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
  `onMouseOver`/`onMouseOut`, `value_onchange`, `onDragEnd` and (ATA-170)
  `onMouseUp` on sliders, `onEndMove` after `moveTo`, `onClose` when the
  skin closes the window, and `<property>_onchange` whenever a script sets
  that property. A sticky button's `down` flips before its `onClick` reads
  it; one whose `down` is bound (`wmpprop:player.settings.mute`) goes back
  to the binding after. A named transport button still does its own job and
  then runs its `onClick`; a mute button with an `onClick` mutes through it.
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
  a live stream has no length. (Reversed by ATA-165 for seek sliders during
  a pick.) Each sends its own message, and Mute sends the opposite of the
  host's mute. Sliders bound to the volume or balance, named or not, start
  at the host's saved values and send `volume` and `balance`, scaled from
  the slider's own range; EQ sliders show the saved gains. A button whose
  `down` is bound to `player.settings.mute` (9SeriesDefault's) is a mute
  button, and draws pressed only while the host is muted. The elapsed time
  is blank while stopped, as in WMP, and while paused, because pausing drops
  the stream and its clock reads 0. (ATA-165: a paused pick keeps its place,
  so shows its time.)

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

### WMP 7.1's own skin engine, read with REA (ATA-212, 2026-10-21)

Static analysis of WMP 7.1's `wmpui.dll`, `wmploc.DLL` and type libraries
checked the engine's guesses against what WMP does. The findings, the
evidence and a ranked list of differences are in
`docs/research/wmp-skin-engine.md`. The engine is unchanged by it; each
difference worth fixing becomes an issue of its own. Two earlier choices
are confirmed: ATA-192's slider end caps for backgrounds (WMP also draws
a full foreground's far cap, which we never do) and ATA-110's empty
`RT_TEXT/#132` stand-in, since
WMP's shared script holds only the `ps*`/`os*` constants.

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
