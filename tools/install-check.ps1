# Usage: install-check.ps1 <setup.exe> [-UpdateTo <version>] [-Out <dir>]
# Installs the app silently, starts it, and checks that it plays: the skin
# reports "Playing" and its clock moves. With -UpdateTo, it then waits for
# the app to update itself to that version and checks again. Last, it
# uninstalls and checks that nothing is left. The release workflow runs it on
# a fresh windows-latest runner; on a machine in use it installs a real copy.
# Writes a screenshot of the skin and the skin's name to -Out.
param([string]$Installer, [string]$UpdateTo = "", [string]$Out = "install-check")
$ErrorActionPreference = "Stop"
$product = "NTS Radio Bootleg Media Player"
$tools = $PSScriptRoot
New-Item -ItemType Directory -Force $Out | Out-Null

function Entry { Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | Get-ItemProperty | Where-Object DisplayName -eq $product }
function Cdp([string]$expr) { (node "$tools/cdp.mjs" 9355 skin $expr 2>$null) -join "" | ConvertFrom-Json }

# Waits until the skin plays and its clock has moved, then saves a screenshot.
function Check-Playing([string]$name) {
  $deadline = (Get-Date).AddSeconds(90)
  $first = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep 2
    try { $s = Cdp "[__wmpScope.player.status, __wmpScope.player.controls.currentPosition, __wmpScope.player.currentMedia.name]" } catch { continue }
    if (-not $s -or $s[0] -ne "Playing") { continue }
    if ($null -eq $first) { $first = $s[1]; continue }
    if ($s[1] -gt $first + 2) {
      "playing: $($s[2]), clock $($first) s -> $($s[1]) s"
      node --input-type=module -e "import { connect } from '$($tools.Replace('\', '/'))/cdp.mjs'; import { writeFileSync } from 'node:fs'; const c = await connect(9355, 'skin'); const r = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync('$Out/$name.png', Buffer.from(r.result.data, 'base64')); c.close();"
      $skins = Get-ChildItem "$env:LOCALAPPDATA\com.datatuna.ntswmp\skins" -Filter *.wmz -ErrorAction SilentlyContinue
      $list = Get-Content "$tools/../skins/compatible.json" -Raw | ConvertFrom-Json
      $worn = foreach ($f in $skins) { ($list | Where-Object md5 -eq $f.BaseName).path }
      "skin: $(if ($worn) { $worn -join ', ' } else { 'the house skin (no skin downloaded)' })" | Tee-Object "$Out/$name-skin.txt"
      return
    }
  }
  throw "the app did not play within 90 s (last status: $($s -join ' | '))"
}

Start-Process $Installer -ArgumentList "/S" -Wait
$entry = Entry
if (-not $entry) { throw "no Settings > Apps entry after installing" }
$dir = $entry.InstallLocation.Trim('"')
$exe = Join-Path $dir "nts-desktop-wmp.exe"
if (-not (Test-Path $exe)) { throw "$exe is missing" }
"installed $($entry.DisplayVersion) in $dir"

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9355 --mute-audio --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --enable-features=HardwareMediaKeyHandling"
Start-Process $exe | Out-Null
Check-Playing "installed"

if ($UpdateTo) {
  # The app checks for a newer release on launch, installs it and restarts.
  $deadline = (Get-Date).AddSeconds(300)
  while ((Entry).DisplayVersion -ne $UpdateTo) {
    if ((Get-Date) -gt $deadline) { throw "still $((Entry).DisplayVersion) after 300 s, not $UpdateTo" }
    Start-Sleep 5
  }
  "updated itself to $UpdateTo"
  Start-Sleep 10
  if (-not (Get-Process nts-desktop-wmp -ErrorAction SilentlyContinue)) { throw "the app did not restart after updating" }
  Check-Playing "updated"
}

Get-Process nts-desktop-wmp -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3
Start-Process (Join-Path $dir "uninstall.exe") -ArgumentList "/S" -Wait
# The uninstaller runs a copy of itself from %TEMP% and returns at once.
$deadline = (Get-Date).AddSeconds(60)
while ((Test-Path $exe) -or (Entry)) {
  if ((Get-Date) -gt $deadline) { throw "uninstall left $(if (Test-Path $exe) { $exe } else { 'the Settings > Apps entry' })" }
  Start-Sleep 2
}
$shortcuts = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu", "$env:USERPROFILE\Desktop" -Recurse -Filter "$product*.lnk" -ErrorAction SilentlyContinue
if ($shortcuts) { throw "uninstall left $($shortcuts.FullName -join ', ')" }
"uninstalled: no files, entry or shortcuts left"
