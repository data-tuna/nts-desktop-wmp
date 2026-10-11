# Usage: window-shot.ps1 <window-title> <out.png>
# Captures only the process's own window with PrintWindow, never the desktop
# behind it. Transparent areas come out black.
param([string]$Title, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public static class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
}
"@
[W]::SetProcessDPIAware() | Out-Null
# By title: the process's MainWindowHandle can be Tao's hidden event window.
$h = [W]::FindWindow([NullString]::Value, $Title)
if ($h -eq [IntPtr]::Zero) { Write-Error "no window titled $Title"; exit 1 }
$r = New-Object RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[W]::PrintWindow($h, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"window rect: L=$($r.L) T=$($r.T) W=$($r.R - $r.L) H=$($r.B - $r.T)"
