#!/bin/bash
# The macOS runner's checks for ATA-230: screenshots of the house skin, then
# click-through, drag, single instance, Cmd+H, Cmd+Q, the remembered
# position, Cmd+W, and the probe skin. CI only: it clicks and types.
#
#   tools/macos/check.sh <app binary> <out dir>
set -u
app=$1 out=$2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
swiftc -O -o "$out/mac" "$here/mac.swift" || exit 1
mac=$out/mac
log() { echo "$*" | tee -a "$out/results.txt"; }
export NTS_WMP_SKIN=$PWD/skins/house/house.wmz
data="$HOME/Library/Application Support/com.datatuna.ntswmp"
state=$data/.window-state.json
rm -f "$state"
# A remembered skin not on the list: no launch downloads from archive.org.
mkdir -p "$data"
echo '{"skin":"ci/none"}' > "$data/skin.json"

launch() { "$app" >>"$out/app.log" 2>&1 & sleep "${1:-20}"; }
running() { pgrep -x nts-desktop-wmp | wc -l | tr -d ' '; }
bounds() { "$mac" window; }
shots() {
  read -r id x y w h < <(bounds) || { log "$1: no window"; return; }
  screencapture -x -o -l "$id" "$out/$1-window.png"
  screencapture -x -R "$((x - 30)),$((y - 30)),$((w + 60)),$((h + 60))" "$out/$1-region.png"
  screencapture -x "$out/$1-screen.png"
}

launch
log "window: $(bounds)"
shots house
screencapture -x -R 0,0,1920,40 "$out/menubar.png"

failed=0
expect() {
  if eval "$2"; then log "ok: $1"; else log "FAILED: $1"; failed=1; fi
}
at() { bounds | cut -d' ' -f2,3; }
read -r _ x y w h < <(bounds)
body() { echo $((x + 395)) $((y + 30)); }  # the dark panel's top right: no control there
"$mac" click $(body); sleep 1
log "after a click on the skin's body, in front: $("$mac" front)"
"$mac" click $((x + 3)) $((y + 3)); sleep 1
front=$("$mac" front)
expect "a click on the clear top-left corner goes through (in front: $front)" '[ "$front" = Finder ]'
# Known (decisions.md, ATA-230): pressed while another app is in front, the
# player comes forward but does not drag. Logged, not checked.
"$mac" click $(body); sleep 1
"$mac" drag $(body) $((x + 395 + 120)) $((y + 30 + 80)); sleep 1
log "a drag while Finder was in front: $(at), in front: $("$mac" front)"
read -r _ x y w h < <(bounds)
"$mac" drag $(body) $((x + 395 - 60)) $((y + 30 - 40)); sleep 1
expect "a drag by -60,-40 from $x $y moves the window ($(at))" '[ "$(at)" = "$((x - 60)) $((y - 40))" ]'

"$app" >>"$out/app.log" 2>&1 &
sleep 5
expect "a second launch leaves one process" '[ "$(running)" = 1 ]'

"$mac" key 4; sleep 2
expect "Cmd+H hides the window" '[ "$(bounds)" = none ]'
"$app" >>"$out/app.log" 2>&1 &
sleep 5
expect "another launch shows it again" '[ "$(bounds)" != none ]'

before=$(at)
"$mac" click $(read -r _ x y _ _ < <(bounds); echo $((x + 395)) $((y + 30))); sleep 1
"$mac" key 12; sleep 3
expect "Cmd+Q quits" '[ "$(running)" = 0 ]'
log "saved state: $(cat "$state" 2>&1)"

launch
expect "the next launch opens where it was ($before)" '[ "$(at)" = "$before" ]'
"$mac" click $(read -r _ x y _ _ < <(bounds); echo $((x + 395)) $((y + 30))); sleep 1
"$mac" key 13; sleep 3
expect "Cmd+W closes the player, and so quits" '[ "$(running)" = 0 ]'

pkill -x nts-desktop-wmp
node "$here/probe.mjs" "$out/probe.wmz"
# The probe minimises the window when done; the second launch restores it.
NTS_WMP_SKIN=$out/probe.wmz launch 75
"$app" >>"$out/app.log" 2>&1 &
sleep 5
shots probe
pkill -x nts-desktop-wmp
exit $failed
