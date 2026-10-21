# How WMP 7.1's skin engine behaves (ATA-212, 2026-10-21)

Our engine was written from Microsoft's skin reference and from what real
skins do. Where neither said enough, it guessed. This note checks those
guesses against WMP's own skin engine, using static analysis with REA and
Ghidra. Nothing here was run: WMP 7.1 was only extracted, never installed,
and WMP 12 refuses third-party skins. Every finding is read from code.

## Method and clean-room rules

- **Target:** WMP 7.1 (7.01.00.3055), chosen in ATA-211 because 59 of our
  `works` skins date from 2000–2002 and use only WMP 7 features. The skin
  engine is `wmpui.dll` (32-bit x86, SHA-256 `6db62513…f5f0a7`). The shared
  script is in `wmploc.DLL` (`61beed69…59a00`); the type library is in
  `wmp.ocx` (`713a6083…45ea`). The binaries stay on the analysis machine and
  never enter this repository.
- **Tools:** REA 6.7 over Ghidra 12.1.4, default auto-analysis. No PDB was
  available, so functions carry Ghidra's `FUN_<address>` names; addresses
  are in `wmpui.dll`'s preferred image (base `0x52500000`).
- **Clean room:** this note describes behaviour in our own words. It quotes
  no decompiled code, disassembly, Microsoft script text, string tables or
  images; only short identifiers (addresses, constant names, member names,
  numbers).
- **Confidence:** *high* means the code path was read end to end; *medium*
  means the path was read but a step (a COM call through a vtable, a
  caller) was inferred; *low* means a reasonable reading that needs a
  runtime check.
- **"Skins affected"** counts the 59 skins `skins/compatible.json` marks
  `works` that use the attribute or member, from ATA-211's survey.

## Differences worth fixing, ranked

Ranked by how many working skins they touch, how sure we are, and how
cheap the fix looks. The sections below have the evidence. Mika turns
these into issues; ATA-215 fixed rows 1, 2 and 10, ATA-216 row 3, ATA-217
row 4 and ATA-218 rows 6–9 and 11. "Ours" there says what the engine did
before.

| # | Difference | WMP 7.1 | Ours | Skins | Confidence |
|---|---|---|---|---|---|
| 1 | Slider thumb position | Thumb centre on the value edge; track not shortened by the thumb; thumb aligned to the track's top (or left), not centred | Track shortened by the thumb; thumb centred across (fixed in ATA-215) | 51 | high |
| 2 | Slider images are always tiled | The middle of a slider image is always repeated, never stretched | Stretched unless `tiled="true"` (fixed in ATA-215; `tiled="false"` still stretches) | 51 (33 without `tiled`) | medium |
| 3 | Text scrolling defaults | `scrollingAmount` 6 px, `scrollingDelay` 85 ms (min 30), 25 px gap, scrolls even when the text fits, `scrollingDirection` left or right | 1 px, 100 ms (min 16), half-box gap, only when too wide, left only | 17 | high |
| 4 | Colour values | `#RRGGBB` only; 140 named colours; `auto` = the image's top-left pixel; system colours; `none` | Also bare `RRGGBB`; 19 names; no `auto`, no system colours (fixed in ATA-217) | up to 55 | high |
| 5 | `jscript:` attributes | Evaluated once, after the scripts run, in document order; never again | Re-evaluated after every change | all | high (WMP side); fix needs care, see 2c |
| 6 | `network.downloadProgress` | A real member | Missing; the `wmpprop:` binding reads `undefined` (fixed in ATA-218: 100) | 15 | high |
| 7 | Play state 11 | 7.1 has no `psReconnecting`; its states stop at 10 | Host reports 11 on reconnect (fixed in ATA-218: 6) | all that switch on play state | high |
| 8 | Unknown attributes | Dropped with a warning; scripts cannot read them | Stored and readable from script (fixed in ATA-218) | few | high |
| 9 | Boolean values | OLE conversion: `0`/`false` false, `-1`/`true` true; anything else leaves the default | Anything not starting with "false" is true (fixed in ATA-218) | few | medium |
| 10 | Slider foreground's far cap | Drawn when the foreground fills the track | Never drawn: the foreground is clipped at the thumb's middle, short of the cap (fixed in ATA-215) | tiled sliders with `borderSize` | high |
| 11 | `view.minWidth`/`minHeight`, `resizable` default | Present; `resizable` defaults to whether the view has a title bar | Missing (fixed in ATA-218) | 12 / 35 | high |

Not ranked: our `wmpenabled:`/`wmpdisabled:` accept only `player.controls.*`
targets, where WMP accepts any property, but all 33 `works` skins that use
them target `player.controls.*` members we handle (2 other skins use
`player.settings.volume`). See 2d.

## 1. Parsing the `.wms`

**What WMP does.**
- **Its own parser, not MSXML.** Loading a skin creates WMP's own parser
  class (CLSID `{D21C0432-07CD-11D3-BD3F-00C04F6EA5AE}`). For a `.wmz` it
  takes the first zip entry ending in `.wms`; a `.wmz` without one fails
  with `0xC00D0FE7`. Evidence: `FUN_5254811b`, `FUN_52544263`.
- **Encoding.** `FF FE` at the start means UTF-16LE and `EF BB BF` means
  UTF-8; either BOM is dropped. Anything else is converted from the
  system's ANSI code page (code page 0), which is Windows-1252 only on a
  Western-locale system. UTF-16BE and UTF-16 without a BOM are not
  detected. Script files go through the same reader. Evidence:
  `FUN_5253376d`, `FUN_52532f6c`, `FUN_52546e7c`.
- **Case.** Tag names are compared case-insensitively (`lstrcmpiW` via
  `FUN_525316d1`/`FUN_52525a66`). The `jscript:`, `wmpprop:`,
  `wmpenabled:` and `wmpdisabled:` prefixes are matched case-insensitively
  at the very start of the value, with no leading space allowed
  (`_wcsnicmp` in `FUN_52531712`). Attribute names become COM property
  ids through `IDispatch::GetIDsOfNames`, which ignores case; most
  attribute names are not strings in the DLL at all, only entries in its
  type library.
- **How an attribute is applied** (`FUN_5254960a`, `FUN_525499ac`), in
  document order:
  1. A name the element's type library knows: a `jscript:` value is
     evaluated; a `wmpprop:`/`wmpenabled:`/`wmpdisabled:` value becomes a
     binding; any other value is handed to the property setter as a
     string, and the setter converts it (`FUN_5250ab52`).
  2. Otherwise, the name of one of the element's events: the value
     becomes a script handler whose parameters are the event's arguments
     (`FUN_52549e23`).
  3. Otherwise `<property>_onchange`, a handler run when that property
     changes, or one of the view's own events (`onload`, `onclose`,
     `onerror`, `ontimer`, `onresize`, mouse and key events)
     (`FUN_52552318`, `FUN_5254b38c`).
  4. Anything else is dropped with an "unknown property" warning, and
     loading goes on.
- **Errors.** Warnings (an unknown attribute, a value a setter rejects, a
  missing script file) are thrown away unless a diagnostics sink is
  attached, so users never see them; loading continues. A subview whose
  attributes fail is removed on its own. A root that is not `<theme>`, or
  a first child that is not `<view>`, is a fatal error (`0xC00D0FE0`).
  Evidence: `FUN_525450fe`, `FUN_5254f57b`, `FUN_52546b14`.
- **Repeated attributes.** Ordinary properties are applied once per entry
  in order, so the last one wins. The few attributes read by name (`id`,
  `scriptFile`, `titleBar`, `resizable`, `currentViewID`) take the first
  (`FUN_52543f0d`). This assumes the tokenizer keeps duplicates, which we
  did not read.
- **Defaults.** Each element class sets its own in its constructor; we
  read only some of them (sliders, text: sections 4). An element without
  an `id` gets a generated one (`FUN_525495cf`). A view's `resizable`,
  when absent, follows whether it has a title bar (`FUN_5254b10c`). The
  text element's default face is a localised string resource, "Tahoma" in
  English; a face name of 32 characters or more falls back to Arial
  (`FUN_525c4180`).

**Confidence:** high, except the duplicate-attribute rule (medium) and
per-element defaults (only partly read).

**How we differ.**
- Encoding: we hard-code Windows-1252 where WMP uses the system code page.
  That is the same on Western systems and better for us everywhere else,
  since a skin is not tied to the listener's locale. No change.
- Unknown attributes: we keep them and let scripts read them; WMP drops
  them. Harmless unless a skin relies on a failure, so low priority.
- Booleans and numbers: WMP's setters use standard OLE conversion, so
  `"0"` is false, and a value such as `"yes"` or `"10px"` fails and leaves
  the default. Our rule makes `"0"` true. Medium confidence: it assumes
  the setters convert through the standard dispatch path.
- We accept leading spaces before `jscript:` and friends; WMP does not.
  Harmless.
- A non-`<theme>` root: `parse()` falls back to the first element, but
  the engine then finds no `<view>` and the app wears the house skin
  instead. WMP refuses the skin; the listener sees a skin either way.

## 2. Layout and bindings

### 2a. Load order

**What WMP does** (`FUN_52546b14`, `FUN_5254b10c`, `FUN_5254f1e9`,
`FUN_5254b334`):
1. Start the JScript engine and create the player objects.
2. Read the theme's own attributes.
3. Build the view's whole element tree, reading only `id` so far. Every
   element, with or without an `id`, is registered with the script engine.
4. Load each `scriptFile` (split on `;`) into the running engine, so the
   scripts' global code runs now, before any other attribute is set.
5. Read `titleBar` and `resizable`.
6. Apply all other attributes: the view's own, then the elements in
   document order, each container before its children, subviews after the
   main tree, and the non-visual objects (`player`, `mediacenter`) last.
7. Connect the event handlers. (`onLoad` follows.)

So a `jscript:` attribute runs after the skin's scripts have defined their
functions and variables, and an expression that reads an element further
down the document sees that element's defaults. Each expression is
evaluated with the element as its first scope (`FUN_525474ab`,
`SCRIPTTEXT_ISEXPRESSION`), as in our engine.

**Confidence:** high for the order; medium for "a later element shows its
defaults".

**How we differ.** Our order (scripts, then all geometry, then `onLoad`)
matches in outline. Our geometry is worked out lazily, on first read, so
a script or expression that reads an element further down gets that
element's computed geometry, where WMP gives its defaults. This only
matters for an expression that reads an element below it.

### 2b. Sizes

**What WMP does.** A subview with no `width` or `height` takes its
`backgroundImage` size; the view does the same from its own background.
The size is applied after the element's own attributes and its
children's, so a child's expression that reads its parent's size during
load sees the size before this. Each container holds its layout during
load and lays out once at the end. Evidence: `FUN_52556424`,
`FUN_5254f082`, `FUN_5254e672`/`FUN_5254e679`.

**Confidence:** medium-high.

**How we differ.** Same rule for subviews. We size a subview before its
children read it, which is kinder than WMP and has not broken a skin. No
change.

### 2c. `jscript:` is evaluated once

**What WMP does.** The `jscript:` branch evaluates the expression once,
assigns the result once, and registers nothing. Nothing evaluates it again
on a resize or on a later change. Evidence: `FUN_525499ac`.

**Confidence:** high.

**How we differ.** We evaluate `jscript:` geometry again after every
change (decisions.md, ATA-110), and that is what lets Classic shrink and
grow. In WMP, Classic must do that some other way, from its own script or
`onresize`. Matching WMP could break Classic, so any fix should start from
how Classic resizes under WMP, and be checked on Classic and the other
`jscript:`-sized skins.

### 2d. `wmpprop:`, `wmpenabled:`, `wmpdisabled:`

**What WMP does.** The value is split at the first `.`: the part before it
names an object (an element id, `player`, `eq` and so on) and the rest is
a property of that object; with no dot, the property is the element's
own. WMP reads the value at once and assigns it, then registers a change
listener with the target, so later changes are pushed, not polled.
`wmpdisabled:` is `wmpenabled:` inverted. The same listener mechanism
serves `<property>_onchange`. Evidence: `FUN_52549838`, `FUN_525499ac`,
`FUN_52509643`.

**Confidence:** high; how a deeper path such as
`player.settings.volume` is resolved past its first dot is inferred.

**How we differ.** We read bindings again on every paint, which gives the
same result for what we support. Our `wmpenabled:`/`wmpdisabled:`
understand only `player.controls.*`, where WMP accepts any boolean
property, but every `works` skin's target is a `player.controls.*` member
we handle. No change needed.

## 3. Hit-testing and window shape

**What WMP does.**
- **One region builder** (`FUN_5252f340`, with `FUN_5252f060` and the
  pixel reader `FUN_5252ead0`). It scans each row and collects runs of
  pixels that are not the key colour, then joins them into a GDI region
  (`ExtCreateRegion` in batches, `CombineRgn` OR). The compare is exact
  24-bit RGB, with no tolerance; the top byte counts only if the key has
  one. For an 8-bit BMP it finds the palette index of the key colour and
  compares indexes; if no palette entry matches exactly, nothing is keyed.
  An "invert" mode gives the pixels equal to the key instead.
- **buttonGroup** (`FUN_5255b0a9`, `FUN_5255a5a1`, `FUN_525511ba`). At
  load, each button element with a `mappingColor` gets its own region:
  the pixels of the `mappingImage` equal to its colour. The group's hit
  area is the union. A pixel that matches no element hits nothing; black
  and white are not special.
- **transparencyColor** is the same exact compare (`FUN_5252fd90`).
- **Colour values** (`FUN_52530dbc`, `FUN_52530aac`): `#RRGGBB` with
  exactly 7 characters; one of 140 named colours (a sorted table at
  `0x525cfc18`); for some attributes one of 28 system colours (resolved
  with `GetSysColor`), `none`, or `auto`. `auto` takes the colour of the
  image's top-left pixel (`FUN_52530d79`, `FUN_5255b9e2`, `FUN_52566a0a`).
  A bare `RRGGBB` is rejected.
- **Window shape** (`FUN_5255413e`). With a skin region, WMP removes the
  window frame and menu, moves the region into window coordinates and
  calls `SetWindowRgn`. Without one, it restores the frame.
- **clippingColor.** One element type builds two regions from one image:
  the pixels not equal to one colour, and the pixels equal to another,
  both clipped to the element's size (`FUN_52559988`, `FUN_52559b4e`). We
  could not tie the two colours to `clippingColor` and `transparencyColor`
  for certain, nor confirm whether it is the view or the subview.

**Confidence:** high, except `clippingColor` (medium-low).

**How we differ.**
- Exact matching, no tolerance and no special colours: as ours.
- Colours: as WMP since ATA-217. The 28 system colours are fixed at
  Windows' defaults rather than read from the machine.
- 8-bit BMPs: we decode to RGB first, so a key colour that is not in the
  palette never matches either. Same result.

## 4. Sliders, text and effects

### Sliders

Constructor `FUN_5256829b`, layout `FUN_5256bdbe`, value mapping
`FUN_5256be7a`, rects and thumb `FUN_5256ad0e`, paint `FUN_5256a8b6`, tiling
`FUN_5252e710`.

**What WMP does.**
- **Defaults:** `min` 0, `max` 100, `value` 0, `borderSize` 0, `direction`
  horizontal, cursor "hand", every colour `none`.
- **Natural size:** the largest width and height among the background,
  foreground, their hover images and the disabled image
  (`FUN_5256bc23`).
- **Track:** the element inset by `borderSize` at each end. The thumb's
  size is not taken off the track.
- **Value to pixels:** the edge is (value − min) / (max − min) × track
  length, rounded to the nearest pixel. `max` below `min` reverses the
  slider; a value outside the range leaves the layout as it was. The
  foreground runs from the track's start to the edge.
- **Thumb:** its centre sits on the edge, so it overhangs the track by
  half its size at either end. Across the slider it lines up with the
  track's top (horizontal) or left (vertical) edge; it is not centred.
- **Images:** the middle of each image is always repeated; this paint path
  has no stretch. With `borderSize` above 0, the first and last
  `borderSize` px are end caps drawn once, and only the middle repeats.
  This is cropped for foreground images always, and for background images
  when one of three flags is set (default on), probably `tiled`. The
  foreground's start cap is drawn whenever the foreground is not empty;
  its far cap only when it fills the whole track.
- **Image fallbacks:** hover background falls back to the background,
  hover foreground to the foreground, disabled to the background.

**Confidence:** high, except which flag is `tiled` (low-medium), and
therefore whether `tiled="false"` changes anything.

**How we differ.** Ranks 1, 2 and 10 were fixed in ATA-215: the engine now
does what WMP does above, except that `tiled="false"` still stretches. The
notes below are what it did before.
- **Thumb (rank 1).** We shorten the track by the thumb and centre the
  thumb across it. WMP does neither. At the ends of the range our thumb
  sits half a thumb further in than WMP's, and a thumb that is thinner or
  thicker than its track sits differently across it.
- **Tiling (rank 2).** We stretch unless `tiled="true"`. WMP repeats the
  middle in every case we read. Microsoft's page saying `tiled` defaults
  to true fits this. The ATA-192 end-cap rule is confirmed for
  backgrounds. For the foreground, WMP draws the far cap when the
  foreground fills the track; we never draw it, since we clip the
  foreground at the thumb's middle, short of the cap (rank 10).
- Natural size: we use the background, else the thumb. Rarely matters.

### Text

Constructor `FUN_525724c8`; setters `FUN_5257374f`, `FUN_5257383b`,
`FUN_52573940`, `FUN_525739ff`; scroll tick `FUN_52573e1d`; wrap
`FUN_52573f0f`.

**What WMP does.**
- `scrolling` defaults to false.
- `scrollingDirection` defaults to left; only `left` and `right` are
  accepted.
- `scrollingAmount` defaults to 6 px and must be at least 1.
- `scrollingDelay` defaults to 85 ms; values under 30 are rejected.
- Each tick moves the text by the amount in the chosen direction. When it
  has moved fully out, it jumps back by the text's width plus 25 px, so
  the repeat follows a 25 px gap.
- **It scrolls whether or not the text fits the box.**
- Word wrap and the ellipsis are off while scrolling.
- `foregroundColor` defaults to black. A field set to 10 may be the
  default font size (ours is 8 pt); not confirmed.
- Fonts (`FUN_525c4180`): the height is the point size scaled by the
  screen's DPI; bold gives weight 700, otherwise 400; text is drawn
  without anti-aliasing unless a flag is set, which may be
  `fontSmoothing`.

**Confidence:** high, except the font size and the anti-aliasing flag
(low).

**How we differ.** Fixed in ATA-216: the engine now does what WMP does
above. Before, our defaults were 1 px every 100 ms with a half-box gap,
we scrolled only text wider than its box, and we ignored
`scrollingDirection`. A skin that set `scrolling="true"` without the
other attributes scrolled six times slower with us, and a short title that
WMP would scroll stood still.

### Effects

**What WMP does.** Not traced to the end. The strings point to effects
being COM plug-ins listed under the `Effects` key in WMP's registry
settings (`wmpvis.dll` among them), with the current effect and preset
saved as `CurrentEffectType` and `CurrentEffectPreset` (referenced at
`0x5254d52b` and `0x5254d766`).

**Confidence:** low.

**How we differ.** We draw our own visualisations and keep the choice in
`localStorage`. Nothing to fix from this.

## 5. The shared script, `res://wmploc.dll/RT_TEXT/#132`

**What WMP does.** In WMP 7.1's `wmploc.DLL` (resource type 256, id 132,
about 2.5 KB of UTF-16) the shared script defines no functions. It is a
comment header and a list of integer constants: the open states
`osUndefined` (0) to `osMediaWaiting` (20), and the play states
`psUndefined` (0) to `psReady` (10). Nothing else: no media types, no
shuffle modes, no helpers. Today's copy (in `wmploc.dll.mun`) is the same
list plus three later additions: `osOpeningUnknownURL` (21),
`psReconnecting` (11), and an array of playlist-change event names.

The other `RT_TEXT` ids in 7.1's `wmploc.DLL` are WMP's own built-in views
and their scripts (the playlist pane, the EQ/SRS settings, the
visualisation pane, full mode, the compact skin, the OCX layouts). No skin
in the archive references any of them: the survey finds only #132, in 122
skins (44 of the 59 `works` skins).

**Evidence.** Read from the resource table with the DLL loaded as data
only; the 7.1 and current copies were compared line by line. Kept on the
analysis machine.

**Confidence:** high.

**How we differ.**
- Our empty stand-in for every `RT_TEXT` id is right: the script only
  carries constants, and we put the same constants in the skin's scope.
- We define `psReconnecting` (11) and `osOpeningUnknownURL` (21), which
  the 7.1 script does not, and the host reports play state 11 when a
  stream reconnects. A 2000–2002 skin has no name for 11: a `switch` on
  the play state falls to its default branch. WMP 7.1 itself has no
  reconnecting state (its type library stops at `wmppsReady`, 10).

### The other `wmploc` resources skins use

- **`RT_STRING`.** 7.1's #2063 is "Disconnected", as our stand-in says.
  The other ids `works` skins use: #1998 and #1999 are an author name and a
  copyright line (circle); #2077, #2078, #2080 and #2081 are status texts
  about protected content, a provider's authentic content, network
  congestion and poor reception; #2097–#2099 are not in 7.1 (9SeriesDefault
  is a WMP 9 skin). We return `""` for all but #2063.
- **`RT_IMAGE`.** 7.1 has no numbered `RT_IMAGE`s, only nine named status
  GIFs. Today's ids 1776–1784, 2023 and 2024 are all 32×15 GIFs; our
  stand-ins are 9×9. Only 9SeriesDefault uses them.
- **`RT_BITMAP`.** 9SeriesDefault references #288–#294, #373–#375, #423,
  #424 and #427. We have no `RT_BITMAP` stand-in. In 7.1 these ids are
  72×72 and 38×38 bitmaps that a WMP 9 skin did not mean, so 7.1 is no
  guide here.

## 6. The object model

**What WMP does.** From the type libraries in `wmp.ocx` and `wmpcore.dll`:

- `WMPPlayState` has 11 values, 0–10, and `WMPOpenState` has 22, 0–21, in
  the usual order. The skin-visible `ps*`/`os*` names come from the shared
  script above, not from the type library, which is why 7.1 skins see no
  `osOpeningUnknownURL` although the enum has it.
- `WMPPlaylistChangeEventType` runs from `wmplcUnknown` (0) to `wmplcLast`
  (10). There is no shuffle-mode enum: `settings.getMode`/`setMode` take
  strings (`"shuffle"`, `"loop"`).
- Members 7.1 has and we lack, by how many `works` skins use them (from
  the survey; its member scan has some noise):
  - `network.downloadProgress` (15 skins, all through `wmpprop:`).
  - `view.minWidth`/`minHeight` (5), `maxWidth`/`maxHeight`, plus
    `titleBar`, `resizable`, `focusObjectID`, `maximize`, `restore`.
  - eq: `enhancedAudio`, `wowLevel`, `truBassLevel` (4), `speakerSize`,
    `currentSpeakerName` (2). `crossfade` and `splineTension` are WMP 9.
  - `player.cdromCollection.item` (7), `currentMedia.setItemInfo` (1).
  - Element members: `useForegroundProgress`/`foregroundProgress` on
    sliders, `foregroundHoverImage`/`backgroundHoverImage`, text
    `wordWrap`, `fontSmoothing` and `scrollingDirection`, and on every
    element `elementType`, `tabStop` and `passThrough`.
- `theme.playSound` is not on 7.1's `IWMPTheme`, so our no-op costs
  nothing. `theme.openViewRelative` is later than 7.1.
- Default values (volume, balance and so on) are not in the type library
  and were not traced in code.

**Evidence.** `LoadTypeLibEx` with no registration, enumerating each
interface's members and each enum's values.

**Confidence:** high for names and values; the skin counts are rough.

**How we differ.** Our ps 0–10 and os 0–20 values match exactly. The
extra 11 and 21 are covered above. The missing members read as
`undefined` and are logged, which most skins survive; the ones worth
adding are `network.downloadProgress` (a `wmpprop:` binding in 15 working
skins that now reads `undefined`) and `view.minWidth`/`minHeight`.

## Still open

- Per-element defaults other than sliders and text (`visible`, `zIndex`,
  `tabStop` and the rest) live in each class's constructor and were not
  read.
- The XML tokenizer: entities, duplicate attributes, malformed markup.
- Which slider flag is `tiled`, and whether `tiled="false"` stretches.
- The default text size (possibly 10) and what turns on anti-aliasing.
- How `clippingColor` maps onto the two-colour region code, and whether it
  shapes the view, the subview or both.
- The effects host.
- WMP 12's `wmp.dll` was not compared. Its public symbols would name the
  functions above, and would show what changed after 7.1.

Every finding here is static. A runtime check of the top items needs WMP
7.1 running on an isolated machine, which is out of scope here: WMP 12
refuses third-party skins, and ATA-211 ruled out installing anything that
replaces or changes the system's WMP.
