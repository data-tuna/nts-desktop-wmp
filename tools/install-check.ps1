# Usage: install-check.ps1 <setup.exe> [-UpdateTo <version>] [-Out <dir>]
# Installs the app silently, starts it, and checks that it plays: it holds a
# connection to a radiomast audio edge, and the skin it downloaded is a
# working one from skins/compatible.json.
# With -UpdateTo, it then waits for the app to update itself to that version
# and checks again. Last, it uninstalls and checks that nothing is left. The
# release workflow runs it on a fresh windows-latest runner; on a machine in
# use it installs a real copy and plays out loud. It writes window shots
# and the skin's name to -Out.
#
# Not over DevTools: the runner's WebView2 took neither
# WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS nor its per-app policy, so no
# DevTools port opened there. PrintWindow drew it black there too.
param([string]$Installer, [string]$UpdateTo = "", [string]$Out = "install-check")
$ErrorActionPreference = "Stop"
$product = "NTS Radio Bootleg Media Player"
$tools = $PSScriptRoot
New-Item -ItemType Directory -Force $Out | Out-Null

function Entry { Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | Get-ItemProperty | Where-Object DisplayName -eq $product }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public static class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
}
"@

# The app's connections to a radiomast audio edge, by local port.
function Stream {
  $ids = (Get-Process nts-desktop-wmp, msedgewebview2 -ErrorAction SilentlyContinue).Id
  Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemotePort -eq 443 } | ForEach-Object {
    $name = try { (Resolve-DnsName $_.RemoteAddress -Type PTR -ErrorAction Stop | Select-Object -First 1).NameHost } catch { "" }
    if ($name -like "audio-edge-*.radiomast.io") { [pscustomobject]@{ Port = $_.LocalPort; Host = $name } }
  }
}

# The window as the screen shows it.
function Shot([string]$file) {
  $h = [Win]::FindWindow([NullString]::Value, $product)
  $r = New-Object RECT
  if ($h -eq [IntPtr]::Zero -or -not [Win]::GetWindowRect($h, [ref]$r)) { return }
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
}

# Waits until the app holds one connection to a radiomast audio edge for
# 15 s, which is the stream playing (a failed stream drops it and
# reconnects), then checks the skin it downloaded.
function Check-Playing([string]$name) {
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep 5
    $now = @(Stream)
    "$(Get-Date -Format HH:mm:ss) edges: $(($now | ForEach-Object { "$($_.Host):$($_.Port)" }) -join ', ')" | Add-Content "$Out/$name-poll.txt"
    $first = $now | Select-Object -First 1
    if (-not $first) { continue }
    Shot "$Out/$name-1.png"
    Start-Sleep 15
    if (-not (Stream | Where-Object Port -eq $first.Port)) { continue }
    Shot "$Out/$name-2.png"
    "playing: one connection to $($first.Host) for 15 s"
    $list = Get-Content "$tools/../skins/compatible.json" -Raw | ConvertFrom-Json
    $skins = Get-ChildItem "$env:LOCALAPPDATA\com.datatuna.ntswmp\skins" -Filter *.wmz -ErrorAction SilentlyContinue
    if (-not $skins) { throw "no skin was downloaded" }
    foreach ($f in $skins) {
      $md5 = (Get-FileHash $f.FullName -Algorithm MD5).Hash.ToLower()
      $known = $list | Where-Object md5 -eq $md5
      if (-not $known -or $known.status -ne "works") { throw "$($f.Name) is not a working skin from compatible.json" }
      "skin: $($known.path) (md5 matches compatible.json, status works)" | Tee-Object -Append "$Out/$name.txt"
    }
    return
  }
  $ids = (Get-Process nts-desktop-wmp, msedgewebview2 -ErrorAction SilentlyContinue).Id
  Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Format-Table LocalPort, RemoteAddress, RemotePort, State | Out-String | Add-Content "$Out/$name-poll.txt"
  Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Format-Table LocalPort, LocalAddress | Out-String | Add-Content "$Out/$name-poll.txt"
  Get-Content "$Out/$name-poll.txt" | Write-Host
  throw "no steady connection to a radiomast audio edge within 150 s: not playing"
}

Start-Process $Installer -ArgumentList "/S" -Wait
$entry = Entry
if (-not $entry) { throw "no Settings > Apps entry after installing" }
$dir = $entry.InstallLocation.Trim('"')
$exe = Join-Path $dir "nts-desktop-wmp.exe"
if (-not (Test-Path $exe)) { throw "$exe is missing" }
"installed $($entry.DisplayVersion) in $dir"

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
