# Runs the project's whole API test suite against the PACKAGED app: the bundle's own Node 22, its own hoisted node_modules,
# its own PostgreSQL and Redis — so a missing module or a Windows-only problem shows up exactly as it would on the laptop.
# (The packaged app normally allows one shop and one login; this extra instance switches those two limits off, because the
#  tests register many shops. Everything else is identical to what the desktop icon starts.)
#
#   powershell -ExecutionPolicy Bypass -File test-bundle.ps1 -Root E:\HisabKitab\_test\TwishaPOS -Data E:\HisabKitab\_test\data
param([string]$Root = 'E:\HisabKitab\_test\TwishaPOS', [string]$Data = 'E:\HisabKitab\_test\data', [int]$Port = 4471,
      [string]$Repo = 'E:\HisabKitab\tyrePlatform')
$env:TWISHA_DATA = $Data; $env:TWISHA_NO_BROWSER = '1'
$cfgFile = "$Root\config\shop.json"
$cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
if (-not $cfg.pin) {   # the first start removes the PIN from this file once the shop exists; a re-used build folder needs it put back
  $cfg | Add-Member -NotePropertyName pin -NotePropertyValue '7575' -Force
  [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}
$pgPort = if ($cfg.ports.pg) { $cfg.ports.pg } else { 54329 }; $redisPort = if ($cfg.ports.redis) { $cfg.ports.redis } else { 63790 }

# the packaged app's database + job store come up the normal way (this also creates the secrets file on a fresh data folder)
& "$Root\node\node.exe" "$Root\scripts\cli.mjs" start --no-open 2>&1 | Select-Object -Last 2
$secrets = Get-Content "$Data\secrets.json" -Raw | ConvertFrom-Json
$db = "postgresql://postgres:$($secrets.pgPassword)@127.0.0.1:$pgPort/billing_db"
New-Item -ItemType Directory -Force "$Data\files-test" | Out-Null

# a second API instance from the bundle, in production mode like the desktop icon, with the one-shop / one-login limits off
$e = @{ NODE_ENV = 'production'; RATE_LIMIT_MAX = '1000000'; HOST = '127.0.0.1'; PORT = "$Port"; DATABASE_URL = $db; REDIS_URL = "redis://127.0.0.1:$redisPort"
        JWT_SECRET = $secrets.jwtSecret; JWT_EXPIRES_IN = '12h'; RUN_WORKERS_INLINE = 'true'; STORAGE_TYPE = 'local'
        STORAGE_LOCAL_PATH = "$Data\files-test"; TZ = 'Asia/Kolkata'; SINGLE_TENANT = ''; SINGLE_USER = '' }
foreach ($k in $e.Keys) { Set-Item "Env:$k" $e[$k] }
Remove-Item Env:SINGLE_TENANT, Env:SINGLE_USER -ErrorAction SilentlyContinue
$log = "$Data\logs\test-api.log"; Remove-Item $log -ErrorAction SilentlyContinue
$proc = Start-Process "$Root\node\node.exe" -ArgumentList "`"$Root\app\node_modules\tsx\dist\cli.mjs`"", 'src/server.ts' -WorkingDirectory "$Root\app" -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
# (HTTP from inside PowerShell: starting curl.exe in a loop opens a console window each time on laptops where Windows Terminal is the default)
Add-Type -AssemblyName System.Net.Http
$script:hc = New-Object System.Net.Http.HttpClient; $script:hc.Timeout = [TimeSpan]::FromSeconds(3)
function HttpCode($url) { try { [int]$script:hc.GetAsync($url).GetAwaiter().GetResult().StatusCode } catch { 0 } }
$sw = [Diagnostics.Stopwatch]::StartNew()
while ((HttpCode "http://127.0.0.1:$Port/health") -ne 200) {
  if ($sw.Elapsed.TotalSeconds -gt 120 -or $proc.HasExited) { "the packaged app did not start:"; Get-Content "$log.err" -Tail 15; exit 2 }
  Start-Sleep -Milliseconds 500
}
"packaged app answers on :$Port after {0:N1}s (node $((& "$Root\node\node.exe" --version)))" -f $sw.Elapsed.TotalSeconds

try {
  Set-Location "$Repo\apps\api"
  $env:TEST_API_PORT = "$Port"
  npx jest --runInBand 2>&1 | Tee-Object -FilePath "$Data\logs\jest-full.txt" | ForEach-Object { if ($_ -match '^(Tests:|Test Suites:|Time:)|×|●.*›') { "$_" } }
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$Root*" -and $_.CommandLine -like '*server.ts*' -and $_.CommandLine -like "*$Port*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
"--- errors the packaged app logged while the suite ran (missing modules etc.):"
$bad = Select-String -Path $log, "$log.err" -Pattern 'Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|is not defined|ReferenceError|TypeError: .* is not a function' -ErrorAction SilentlyContinue | Select-Object -First 8
if ($bad) { $bad | ForEach-Object { $_.Line.Substring(0, [math]::Min(200, $_.Line.Length)) } } else { 'none' }
