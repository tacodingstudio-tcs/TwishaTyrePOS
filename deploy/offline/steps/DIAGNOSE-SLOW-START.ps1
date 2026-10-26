# Finds out why Twisha POS starts slowly on THIS laptop. Read-only: it measures and reports, it changes nothing.
# Run it right after a restart (before opening anything else), so the numbers show a "cold" start.
# It writes Twisha-diagnosis.txt on the Desktop - send that file back.
$ErrorActionPreference = 'SilentlyContinue'
$report = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Twisha-diagnosis.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { $script:lines.Add($t); Write-Host $t }
function Head([string]$t) { Say ''; Say ('=== ' + $t + ' ===') }

# where Twisha POS is installed: next to this script (installed copy) or the default per-user location
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = if (Test-Path (Join-Path $here 'node\node.exe')) { $here } else { Join-Path $env:LOCALAPPDATA 'Programs\Twisha POS' }
$data = Join-Path $env:LOCALAPPDATA 'TwishaPOS'

Say ('Twisha POS start-up diagnosis  -  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
Say ('Program folder: ' + $app + '   Data folder: ' + $data)

Head 'This computer'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
Say ('Model:    ' + $cs.Manufacturer + ' ' + $cs.Model)
Say ('CPU:      ' + $cpu.Name + '  (' + $cpu.NumberOfCores + ' cores, ' + $cpu.MaxClockSpeed + ' MHz max)')
Say ('Memory:   ' + [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) + ' GB total, ' + [math]::Round($os.FreePhysicalMemory / 1MB, 1) + ' GB free now')
Say ('Windows:  ' + $os.Caption + ' ' + $os.Version)
$up = (Get-Date) - $os.LastBootUpTime
Say ('Up for:   ' + [math]::Round($up.TotalMinutes, 1) + ' minutes since the last restart')
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1
if ($bat) { Say ('Power:    on ' + $(if ($bat.BatteryStatus -eq 1) { 'BATTERY (can slow the computer)' } else { 'mains' }) + ', battery ' + $bat.EstimatedChargeRemaining + '%') }
Say ('Plan:     ' + ((powercfg /getactivescheme) -join ' '))

Head 'Disk'
Get-PhysicalDisk | ForEach-Object { Say ('Disk:     ' + $_.FriendlyName + '  type=' + $_.MediaType + '  bus=' + $_.BusType + '  size=' + [math]::Round($_.Size / 1GB) + ' GB  health=' + $_.HealthStatus) }
$vol = Get-Volume -DriveLetter C
if ($vol) { Say ('C: free   ' + [math]::Round($vol.SizeRemaining / 1GB, 1) + ' GB of ' + [math]::Round($vol.Size / 1GB) + ' GB') }
# speed test: one big file and many small files (what the app mostly does is open many small files)
$tmp = Join-Path $env:TEMP ('twisha-disk-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$buf = New-Object byte[] (1MB); (New-Object Random).NextBytes($buf)
$sw = [Diagnostics.Stopwatch]::StartNew()
$fs = [IO.File]::Create((Join-Path $tmp 'big.bin'))
for ($i = 0; $i -lt 200; $i++) { $fs.Write($buf, 0, $buf.Length) }
$fs.Flush($true); $fs.Close()
Say ('Write 200 MB:            ' + $sw.ElapsedMilliseconds + ' ms   (good: under 1500)')
$sw.Restart()
$small = New-Object byte[] 4096
for ($i = 0; $i -lt 500; $i++) { $f = Join-Path $tmp ("s$i.dat"); [IO.File]::WriteAllBytes($f, $small); [void][IO.File]::ReadAllBytes($f) }
Say ('500 small files:         ' + $sw.ElapsedMilliseconds + ' ms   (good: under 1500; slow = something is scanning / a slow disk)')
Remove-Item $tmp -Recurse -Force

Head 'Security software'
$av = Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct
if ($av) { $av | ForEach-Object { Say ('Antivirus: ' + $_.displayName) } } else { Say 'Antivirus: none reported' }
$mp = Get-MpComputerStatus
if ($mp) { Say ('Windows Security real-time protection: ' + $(if ($mp.RealTimeProtectionEnabled) { 'ON' } else { 'off' }) + '   antivirus enabled: ' + $mp.AntivirusEnabled) }

Head 'What starts with Windows'
$items = Get-CimInstance Win32_StartupCommand
Say ('Start-up programs: ' + @($items).Count)
$items | Select-Object -First 30 | ForEach-Object { Say ('   ' + $_.Name + '   ' + $_.Command) }
$svc = @(Get-Process).Count
Say ('Running processes now: ' + $svc)
Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 | ForEach-Object { Say ('   busiest: ' + $_.ProcessName + '  cpu-seconds=' + [math]::Round($_.CPU, 1) + '  memory=' + [math]::Round($_.WorkingSet64 / 1MB) + ' MB') }

Head 'Windows start-up time (last restarts)'
$ev = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100 } -MaxEvents 4
if ($ev) { $ev | ForEach-Object { Say ('Boot on ' + $_.TimeCreated.ToString('yyyy-MM-dd HH:mm') + ' took ' + [math]::Round($_.Properties[1].Value / 1000) + ' seconds') } } else { Say 'no boot-time records' }

Head 'How long the programs take to launch (first run vs second run)'
function TimeExe([string]$label, [string]$exe, [string]$arg) {
  if (-not (Test-Path $exe)) { Say ($label + ': not found (' + $exe + ')'); return }
  $times = @()
  foreach ($n in 1..2) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Process -FilePath $exe -ArgumentList $arg -WindowStyle Hidden -Wait -RedirectStandardOutput (Join-Path $env:TEMP 'twisha-x.txt')
    $times += $sw.ElapsedMilliseconds
  }
  Say ($label + ': 1st ' + $times[0] + ' ms, 2nd ' + $times[1] + ' ms   (a big gap = the first launch is being scanned / loaded cold)')
}
TimeExe 'node (app runtime)  ' (Join-Path $app 'node\node.exe') '--version'
TimeExe 'database server     ' (Join-Path $app 'pg\bin\postgres.exe') '--version'
TimeExe 'job store (redis)   ' (Join-Path $app 'redis\redis-server.exe') '--version'

Head 'Twisha POS own start-up log (last start)'
$log = Join-Path $data 'logs\setup.log'
if (Test-Path $log) {
  Say '(the [..s] figure on each line is seconds since that start began; the big jumps are the slow parts)'
  Get-Content $log -Tail 40 -Encoding UTF8 | ForEach-Object { Say ('   ' + $_) }
} else { Say 'no setup.log yet' }
foreach ($n in 'postgres.log', 'api.log') {
  $f = Join-Path $data ('logs\' + $n)
  if (Test-Path $f) { Say ''; Say ($n + ' (last 12 lines):'); Get-Content $f -Tail 12 -Encoding UTF8 | ForEach-Object { Say ('   ' + $_.Substring(0, [Math]::Min(160, $_.Length))) } }
}

$lines | Out-File -FilePath $report -Encoding UTF8
Write-Host ''
Write-Host ('Saved: ' + $report) -ForegroundColor Green
Write-Host 'Send that file (Twisha-diagnosis.txt from the Desktop).'
