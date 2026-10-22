#!/bin/bash
# Usage: update-check.sh <old App.app> <new .app.tar.gz> <version> <out dir>
# The macOS update, tried without a tag (ATA-231). Serves the new build's
# .app.tar.gz and a latest.json shaped like tauri-action's from
# http://127.0.0.1:8765, then starts a copy of the old build, natively and
# under Rosetta, and waits until the updater has swapped the bundle for
# <version> and the restarted app is running. Both builds must point their
# updater at that address (update-check.yml's config). CI only: it starts
# the app on the screen.
set -u
old=$1 tarball=$2 version=$3 out=$4
mkdir -p "$out/serve"
out=$(cd "$out" && pwd)
port=8765
name=$(basename "$old")

cp "$tarball" "$out/serve/app.tar.gz"
# tauri-action gives a universal build both darwin keys, plain and -app.
SIG=$(cat "$tarball.sig") URL="http://127.0.0.1:$port/app.tar.gz" VERSION=$version node -e '
  const p = { signature: process.env.SIG, url: process.env.URL };
  const platforms = {};
  for (const k of ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"]) platforms[k] = p;
  console.log(JSON.stringify({ version: process.env.VERSION, notes: "", pub_date: new Date().toISOString(), platforms }, null, 2));
' > "$out/serve/latest.json"

python3 -m http.server $port --bind 127.0.0.1 --directory "$out/serve" > "$out/server.log" 2>&1 &
server=$!
trap 'pkill -f "$out/apps/" 2>/dev/null; kill $server 2>/dev/null' EXIT

# The app's own skin download stays off, as in mac-smoke.sh.
data="$HOME/Library/Application Support/com.datatuna.ntswmp"
mkdir -p "$data"
echo '{"skin":"ci/none"}' > "$data/skin.json"

plist() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null; }

failed=0
for arch in arm64 x86_64; do
  if ! arch -$arch /usr/bin/true 2>/dev/null; then
    echo "::warning::$arch: this runner cannot run it (no Rosetta?), skipped"
    continue
  fi
  app="$out/apps/$arch/$name"
  mkdir -p "$out/apps/$arch"
  ditto "$old" "$app"
  from=$(plist "$app")
  NTS_WMP_SKIN=$PWD/skins/house/house.wmz arch -$arch "$app/Contents/MacOS/nts-desktop-wmp" > "$out/$arch-app.log" 2>&1 &
  deadline=$((SECONDS + 180))
  while [ $SECONDS -lt $deadline ] && [ "$(plist "$app")" != "$version" ]; do sleep 2; done
  now=$(plist "$app")
  if [ "$now" != "$version" ]; then
    echo "::error::$arch: still $now after 180 s, no update to $version"
    cat "$out/$arch-app.log"
    failed=1
    continue
  fi
  # The restart: a process from the swapped bundle, still up 10 s later.
  sleep 10
  pids=$(pgrep -f "$app/Contents/MacOS/nts-desktop-wmp" | tr '\n' ' ')
  if [ -z "$pids" ]; then
    echo "::error::$arch: updated $from to $now, but no app running from it after the restart"
    failed=1
  else
    echo "$arch: updated $from to $now and restarted (pid $pids)"
    file "$app/Contents/MacOS/nts-desktop-wmp" | tee -a "$out/$arch-app.log"
    codesign --verify --deep --strict "$app" && echo "$arch: codesign --verify passes on the updated bundle"
  fi
  pkill -f "$app/Contents/MacOS/nts-desktop-wmp"
  sleep 3
done
cat "$out/server.log"
exit $failed
