#!/bin/bash
# The macOS runner's checks for ATA-230: screenshots of the house skin, then
# click-through, drag, single instance, Cmd+H, Cmd+Q, the remembered
# position, Cmd+W, and the probe skin. CI only: it clicks and types.
#
#   tools/macos/check.sh <app binary> <out dir> [shots]
set -u
app=$1 out=$2 mode=${3:-full}
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
if [ "$mode" = shots ]; then pkill -x nts-desktop-wmp; exit 0; fi

read -r _ x y w h < <(bounds)
body() { echo $((x + 395)) $((y + 30)); }  # the dark panel's top right: no control there
"$mac" click $(body); sleep 1
log "after a click on the skin's body, in front: $("$mac" front)"
"$mac" click $((x + 3)) $((y + 3)); sleep 1
log "after a click on its clear top-left corner, in front: $("$mac" front)"
"$mac" click $(body); sleep 1
log "after another click on the body, in front: $("$mac" front)"
"$mac" drag $(body) $((x + 395 + 120)) $((y + 30 + 80)); sleep 1
log "after a drag by +120,+80: $(bounds)"

"$app" >>"$out/app.log" 2>&1 &
sleep 5
log "second launch: $(running) process(es) running"

"$mac" key 4; sleep 2
log "after Cmd+H: $(bounds)"
"$app" >>"$out/app.log" 2>&1 &
sleep 5
log "after another launch: $(bounds), in front: $("$mac" front)"

"$mac" click $(read -r _ x y _ _ < <(bounds); echo $((x + 395)) $((y + 30))); sleep 1
"$mac" key 12; sleep 3
log "after Cmd+Q: $(running) process(es) running; saved state: $(cat "$state" 2>&1)"

launch
log "relaunched at: $(bounds)"
"$mac" click $(read -r _ x y _ _ < <(bounds); echo $((x + 395)) $((y + 30))); sleep 1
log "before Cmd+W, in front: $("$mac" front)"
"$mac" key 13; sleep 3
log "after Cmd+W: $(running) process(es) running"

pkill -x nts-desktop-wmp
node "$here/probe.mjs" "$out/probe.wmz"
NTS_WMP_SKIN=$out/probe.wmz launch 75
"$app" >>"$out/app.log" 2>&1 &
sleep 5
shots probe
pkill -x nts-desktop-wmp
exit 0
