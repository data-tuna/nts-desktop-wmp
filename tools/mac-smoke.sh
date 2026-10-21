#!/bin/bash
# Usage: mac-smoke.sh <App.app> <skin.wmz> <out dir> <name>
# The macOS runner's version of install-check.ps1 (ATA-229): starts the app
# wearing <skin.wmz>, waits until it plays, and shoots the window and the
# screen into <out dir>/<name>-*.png. "Playing" is one connection to a
# radiomast audio edge held for 15 s, as on Windows. The app's own skin
# download is switched off with a skin.json naming a skin not on the list,
# so the run fetches nothing from archive.org.
set -u
app=$1 skin=$2 out=$3 name=$4
mkdir -p "$out"
log="$out/$name-poll.txt"
data="$HOME/Library/Application Support/com.datatuna.ntswmp"
mkdir -p "$data"
echo '{"skin":"ci/none"}' > "$data/skin.json"

# The addresses streams.radiomast.io sends this machine to now.
edges=$(for i in 1 2 3 4 5; do for ch in nts1 nts2; do
  host=$(curl -sI "https://streams.radiomast.io/$ch" | sed -n 's/^[Ll]ocation: https:\/\/\([^/]*\).*/\1/p' | tr -d '\r')
  [ -n "$host" ] && dig +short A "$host"
done; done | grep -E '^[0-9.]+$' | sort -u)
echo "radiomast edges: $(echo $edges)" >> "$log"

# Established connections to an edge, as "local remote" pairs. netstat
# shows every process's, WebKit's networking process included.
stream() {
  netstat -an -p tcp | awk '$6 == "ESTABLISHED" { print $4, $5 }' | while read -r l r; do
    for ip in $edges; do [ "${r%.443}" = "$ip" ] && echo "$l $r"; done
  done
}

shoot() {
  # The window's number, from its owner's pid.
  id=$(swift - "$pid" <<'EOF'
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where w[kCGWindowOwnerPID as String] as? Int == pid && w[kCGWindowLayer as String] as? Int == 0 {
  print(w[kCGWindowNumber as String]!); break
}
EOF
)
  [ -n "$id" ] && screencapture -x -o -l "$id" "$out/$name-window-$1.png"
  screencapture -x "$out/$name-screen-$1.png"
}

NTS_WMP_SKIN=$skin "$app/Contents/MacOS/nts-desktop-wmp" > "$out/$name-app.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null' EXIT

deadline=$((SECONDS + 150))
while [ $SECONDS -lt $deadline ]; do
  sleep 5
  kill -0 $pid 2>/dev/null || { cat "$out/$name-app.log"; echo "::error::$name: the app exited"; exit 1; }
  first=$(stream | head -1)
  echo "$(date +%T) edges: $(stream | tr '\n' ' ')" >> "$log"
  [ -z "$first" ] && continue
  shoot 1
  sleep 15
  stream | grep -qF "$first" || continue
  shoot 2
  echo "$name: playing, one connection ($first) for 15 s"
  exit 0
done
shoot fail
netstat -an -p tcp >> "$log"
cat "$log" "$out/$name-app.log"
echo "::error::$name: no steady connection to a radiomast audio edge within 150 s: not playing"
exit 1
