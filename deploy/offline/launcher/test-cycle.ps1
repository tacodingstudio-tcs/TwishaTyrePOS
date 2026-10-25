# End-to-end check of the installed layout, against a COPY of the bundle with its own data folder:
#   start -> sign in -> save a bill -> hard kill (power cut) -> start again (data intact?) -> stop+backup -> restore
#   powershell -ExecutionPolicy Bypass -File test-cycle.ps1 -Root E:\HisabKitab\_test\TwishaPOS -Data E:\HisabKitab\_test\data
param([string]$Root = 'E:\HisabKitab\_test\TwishaPOS', [string]$Data = 'E:\HisabKitab\_test\data', [string]$Backups = 'E:\HisabKitab\_test\backups')
$env:TWISHA_NO_BROWSER = '1'   # tests must not open app windows
$env:TWISHA_DATA = $Data; $env:TWISHA_BACKUPS = $Backups
$A = 'http://127.0.0.1:4470'; $fail = 0
function Check($name, $ok, $extra = '') { if ($ok) { "PASS  $name $extra" } else { "FAIL  $name $extra"; $script:fail++ } }
function Api($method, $path, $body, $token) {
  $args = @('-s', '-m', '20', '-X', $method, "$A$path", '-H', 'content-type: application/json')
  if ($token) { $args += @('-H', "authorization: Bearer $token") }
  if ($body) {   # bodies go through a file: Windows PowerShell 5 mangles quotes in native-command arguments
    $f = Join-Path $env:TEMP "tw-body-$PID.json"; [IO.File]::WriteAllText($f, $body)
    $args += @('-H', "Idempotency-Key: t-$([guid]::NewGuid())", '--data-binary', "@$f")
  }
  $out = & curl.exe @args; $script:lastRaw = ($out | Out-String); try { $out | ConvertFrom-Json } catch { $null }
}
function Login { (Api 'POST' '/api/auth/login' '{"tenantPhone":"9227575750","phone":"9227575750","pin":"7575"}').accessToken }
function WaitHealthy($sec) { $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.Elapsed.TotalSeconds -lt $sec) { if ((& curl.exe -s -m 2 -o NUL -w '%{http_code}' "$A/health") -eq '200') { return [math]::Round($sw.Elapsed.TotalSeconds, 1) }; Start-Sleep -Milliseconds 400 }; return -1 }
function Bills($t) { (Api 'GET' '/api/invoices?limit=1&txnType=sale_invoice' $null $t).meta.total }
function KillAll { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Root\*" -or ($_.CommandLine -like "*$Root*" -and $_.Name -match 'node|postgres|redis|pg_ctl') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }

"== 1. clean start with the launcher"
KillAll; Start-Sleep 2
Start-Process "$Root\TwishaPOS.exe" -WorkingDirectory $Root
$t1 = WaitHealthy 120; Check 'launcher starts everything' ($t1 -gt 0) "(healthy after ${t1}s)"
$tok = Login; Check 'sign in 9227575750 / 7575' ([bool]$tok)
$null = Api 'POST' '/api/tyre/import/products' '{"dryRun":false,"rows":[{"brand":"Yokohama","pattern":"BluEarth","size":"215/60 R16","kind":"tyre","vehicleType":"car","salePrice":9000,"stock":10}]}' $tok   # stock for the test bills
$before = Bills $tok
$fin = Api 'GET' '/api/tyre/finder?kind=tyre&limit=1' $null $tok
if (-not $fin.data) { "      finder gave: " + $script:lastRaw.Substring(0, [math]::Min(300, $script:lastRaw.Length)) }
$prod = $fin.data[0].id
$sale = Api 'POST' '/api/tyre/sales' ('{"customer":{"name":"Cycle Test","phone":"9876509999"},"items":[{"productId":"' + $prod + '","qty":1}],"payments":[{"method":"cash","amount":1000}]}') $tok
Check 'a bill saves' ([bool]$sale.invoice.number) "($($sale.invoice.number)) $(if (-not $sale.invoice.number) { $script:lastRaw.Substring(0, [math]::Min(300, $script:lastRaw.Length)) })"
$after = Bills $tok; Check 'bill count went up by one' ($after -eq $before + 1) "($before -> $after)"

"== 2. power cut: kill everything without warning"
KillAll; Start-Sleep 3
Check 'everything is down' ((& curl.exe -s -m 2 -o NUL -w '%{http_code}' "$A/health") -ne '200')
Remove-Item "$Data\pg-data\postmaster.pid" -ErrorAction SilentlyContinue   # what a real power cut leaves behind is a stale pid file; Postgres must cope
Start-Process "$Root\TwishaPOS.exe" -WorkingDirectory $Root
$t2 = WaitHealthy 120; Check 'starts again after the kill' ($t2 -gt 0) "(healthy after ${t2}s)"
$tok = Login; $again = Bills $tok
Check 'no bill lost after the kill' ($again -eq $after) "($again bills)"

"== 3. stop with backup, then restore an older backup"
$null = Start-Process "$Root\TwishaPOS.exe" -ArgumentList '--stop' -Wait -PassThru -WindowStyle Hidden
Check 'stop closes the tray icon too' (-not (Get-Process TwishaPOS -ErrorAction SilentlyContinue))
Check 'database stopped' (-not (Get-Process postgres -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Root\*" }))
$dump = Get-ChildItem $Backups -Filter '*.dump' | Sort-Object LastWriteTime | Select-Object -Last 1
Check 'a backup file was written' ([bool]$dump) "($($dump.Name), $([math]::Round($dump.Length/1KB)) KB)"

Start-Process "$Root\TwishaPOS.exe" -WorkingDirectory $Root; $null = WaitHealthy 120
$tok = Login
$null = Api 'POST' '/api/tyre/sales' ('{"customer":{"name":"After Backup","phone":"9876508888"},"items":[{"productId":"' + $prod + '","qty":1}],"payments":[{"method":"cash","amount":1000}]}') $tok
$extra = Bills $tok; Check 'one more bill after the backup' ($extra -eq $after + 1) "($extra)"
$null = Start-Process "$Root\TwishaPOS.exe" -ArgumentList '--stop' -Wait -PassThru -WindowStyle Hidden
Set-Location $Root; $r = & "$Root\node\node.exe" scripts\cli.mjs restore $dump.FullName --yes 2>&1 | Out-String
Check 'restore finished' ($r -match 'Restored|restored') ($r -split "`n" | Select-Object -Last 3 | Out-String).Trim()
Start-Process "$Root\TwishaPOS.exe" -WorkingDirectory $Root; $null = WaitHealthy 120
$tok = Login; $rest = Bills $tok
Check 'restore brought back the older state' ($rest -eq $after) "($rest bills, expected $after)"
$null = Start-Process "$Root\TwishaPOS.exe" -ArgumentList '--stop' -Wait -PassThru -WindowStyle Hidden
""; if ($fail -eq 0) { 'ALL PASS' } else { "$fail FAILED" }
