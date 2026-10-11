# Usage: cpu.ps1 <process-name> [seconds]
# CPU over the app process and every descendant (WebView2's
# msedgewebview2.exe processes), as a percentage of one core, averaged over
# the given seconds (default 30). Task Manager divides by every core instead.
param([string]$Name, [int]$Seconds = 30)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$root = $all | Where-Object { $_.Name -eq "$Name.exe" } | Select-Object -First 1
if (-not $root) { Write-Error "$Name.exe is not running"; exit 1 }
$ids = New-Object System.Collections.Generic.List[int]
$ids.Add([int]$root.ProcessId)
for ($i = 0; $i -lt $ids.Count; $i++) {
  foreach ($c in $all) { if ($c.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }
}
$procs = $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
function Total { param($p) $t = 0.0; foreach ($x in $p) { $x.Refresh(); if (-not $x.HasExited) { $t += $x.TotalProcessorTime.TotalSeconds } }; $t }
$before = Total $procs
Start-Sleep -Seconds $Seconds
$after = Total $procs
"{0} processes, {1:N1} % of one core over {2} s" -f $procs.Count, (100 * ($after - $before) / $Seconds), $Seconds
