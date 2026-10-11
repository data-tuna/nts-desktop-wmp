# Usage: region-shot.ps1 <window-title> <out.png>
# Like window-shot.ps1, but paints every pixel outside the window's region
# (SetWindowRgn, the skin's shape) as a grey checkerboard, and counts them.
# Reads the region back from Windows; never captures the desktop.
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
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a, int b, int c, int d);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr rgn, int x, int y);
}
"@
[W]::SetProcessDPIAware() | Out-Null
$h = [W]::FindWindow([NullString]::Value, $Title)
if ($h -eq [IntPtr]::Zero) { Write-Error "no window titled $Title"; exit 1 }
$r = New-Object RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc(); [W]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$rgn = [W]::CreateRectRgn(0, 0, 0, 0)
$kind = [W]::GetWindowRgn($h, $rgn)  # 0 = no region set
$outside = 0
if ($kind -ne 0) {
  for ($y = 0; $y -lt $ht; $y++) { for ($x = 0; $x -lt $w; $x++) {
    if (-not [W]::PtInRegion($rgn, $x, $y)) {
      $outside++
      $c = if ((([math]::Floor($x / 6) + [math]::Floor($y / 6)) % 2) -eq 0) { 200 } else { 140 }
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($c, $c, $c))
    }
  } }
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"window {0}x{1} at {2},{3}; region type {4}; {5} of {6} pixels cut away" -f $w, $ht, $r.L, $r.T, $kind, $outside, ($w * $ht)
