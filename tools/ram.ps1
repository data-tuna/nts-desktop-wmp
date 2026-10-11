# Usage: ram.ps1 <process-name>
# Sums memory over the app process and every descendant (WebView2's
# msedgewebview2.exe processes). Private bytes are what the app costs;
# working set is what Task Manager's details tab shows.
param([string]$Name)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
$root = $all | Where-Object { $_.Name -eq "$Name.exe" } | Select-Object -First 1
if (-not $root) { Write-Error "$Name.exe is not running"; exit 1 }
$ids = New-Object System.Collections.Generic.List[int]
$ids.Add([int]$root.ProcessId)
for ($i = 0; $i -lt $ids.Count; $i++) {
  foreach ($c in $all) { if ($c.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }
}
$procs = $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
$priv = ($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
$ws = ($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB
"{0} processes, private {1:N0} MB, working set {2:N0} MB" -f $procs.Count, $priv, $ws
$procs | ForEach-Object { "  {0,-22} {1,6}  private {2,4:N0} MB" -f $_.ProcessName, $_.Id, ($_.PrivateMemorySize64 / 1MB) }
