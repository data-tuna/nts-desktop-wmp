# Usage: hidden-run.ps1 <exe> [desktop-name]
# Starts the app on its own Windows desktop, which is never shown, so it takes
# no focus and covers nothing on the machine's real screen. It inherits this
# shell's environment (set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS first) and
# prints the PID; stop it with Stop-Process -Id <pid>. Screenshots and real
# input do not work there; DevTools does.
param([string]$Exe, [string]$Desktop = "nts-wmp-test")
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class HD {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SI { public int cb; public string r; public string desk; public string title; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] public struct PI { public IntPtr p, t; public int pid, tid; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateDesktop(string n, IntPtr d, IntPtr m, int f, uint a, IntPtr s);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string dir, ref SI si, out PI pi);
}
"@
# GENERIC_ALL: the desktop handle stays open as long as this shell's process,
# and the desktop lives as long as any process runs on it.
if ([HD]::CreateDesktop($Desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero) -eq [IntPtr]::Zero) { Write-Error "CreateDesktop failed"; exit 1 }
$si = New-Object HD+SI; $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si); $si.desk = $Desktop
$pi = New-Object HD+PI
$exePath = (Resolve-Path $Exe).Path
if (-not [HD]::CreateProcess($exePath, "`"$exePath`"", [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, (Split-Path $exePath), [ref]$si, [ref]$pi)) { Write-Error "CreateProcess failed"; exit 1 }
$pi.pid
