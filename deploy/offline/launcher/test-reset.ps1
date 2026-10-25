# ERASE-TEST-DATA: make test records, erase them, and check what stayed and what went - in both modes.
#   powershell -ExecutionPolicy Bypass -File test-reset.ps1 -Root <bundle or installed folder> -Data <scratch data folder>
param([string]$Root = 'E:\HisabKitab\_offline-out\TwishaPOS', [string]$Data = 'E:\HisabKitab\_rs\data', [string]$Backups = 'E:\HisabKitab\_rs\backups')
$env:TWISHA_DATA = $Data; $env:TWISHA_BACKUPS = $Backups; $env:TWISHA_NO_BROWSER = '1'; $env:TWISHA_NO_DETACH = '1'
Add-Type -AssemblyName System.Net.Http
$hc = New-Object System.Net.Http.HttpClient; $hc.Timeout = [TimeSpan]::FromSeconds(30)
$A = 'http://127.0.0.1:4470'; $script:fail = 0; $script:tok = $null
function Check($name, $ok, $extra = '') { if ($ok) { "PASS  $name $extra" } else { "FAIL  $name $extra"; $script:fail++ } }
function Api($method, $path, $body) {
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($method), "$A$path")
  if ($script:tok) { $req.Headers.Add('Authorization', "Bearer $script:tok") }
  if ($body) { $req.Content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json'); $req.Headers.Add('Idempotency-Key', [guid]::NewGuid().ToString()) }
  $r = $hc.SendAsync($req).GetAwaiter().GetResult(); $t = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  try { $j = $t | ConvertFrom-Json } catch { $j = $null }
  [pscustomobject]@{ Code = [int]$r.StatusCode; Json = $j }
}
function Login { for ($i = 0; $i -lt 25; $i++) { $r = Api 'POST' '/api/auth/login' '{"tenantPhone":"9227575750","phone":"9227575750","pin":"7575"}'; if ($r.Json.accessToken) { $script:tok = $r.Json.accessToken; return }; Start-Sleep 1 } }
function RunCli($cmdArgs) { & "$Root\node\node.exe" "$Root\scripts\cli.mjs" @cmdArgs 2>&1 }
function Health { try { [int]$hc.GetAsync("$A/health").GetAwaiter().GetResult().StatusCode } catch { 0 } }
function Up { for ($i = 0; $i -lt 100; $i++) { if ((Health) -eq 200) { return }; Start-Sleep -Milliseconds 400 } }
function Total($path) { (Api 'GET' $path $null).Json.meta.total }
function Tyres { @((Api 'GET' '/api/tyre/finder?kind=tyre&limit=50' $null).Json.data) }
function Services { @((Api 'GET' '/api/tyre/finder?kind=service&limit=50' $null).Json.data).Count }
function MakeTestData {
  $null = Api 'POST' '/api/tyre/import/products' '{"dryRun":false,"rows":[{"brand":"Yokohama","pattern":"BluEarth","size":"215/60 R16","kind":"tyre","vehicleType":"car","salePrice":9000,"purchasePrice":7500,"gstRate":18,"hsn":"4011","stock":20},{"brand":"Dunlop","pattern":"","size":"2.75-18","kind":"tyre","vehicleType":"two_wheeler","salePrice":1600,"purchasePrice":1300,"gstRate":18,"hsn":"4011","stock":20}]}'
  $all = @(Tyres); $car = ($all | Where-Object { $_.name -match '215' } | Select-Object -First 1).id; $bike = ($all | Where-Object { $_.name -match '2\.75' } | Select-Object -First 1).id
  $c = Api 'POST' '/api/tyre/sales' ('{"billSeries":"car","customer":{"name":"Test Customer","phone":"9811100001"},"vehicleNo":"GJ32AA0001","items":[{"productId":"' + $car + '","qty":2}],"payments":[{"method":"cash","amount":5000}]}')
  $w = Api 'POST' '/api/tyre/sales' ('{"billSeries":"two_wheel","customer":{"name":"Test Bike","phone":"9811100002"},"items":[{"productId":"' + $bike + '","qty":1}],"payments":[{"method":"cash","amount":1600}]}')
  $null = Api 'POST' '/api/expenses' '{"category":"rent","description":"test rent","amount":500,"paymentMode":"cash"}'
  $null = Api 'POST' '/api/parties/import' '{"dryRun":false,"rows":[{"name":"Test Supplier","type":"supplier","phone":"9811100003"}]}'
  "   made: bills $($c.Json.invoice.number) [$($c.Code)] and $($w.Json.invoice.number) [$($w.Code)] $(if ($c.Code -ge 300) { $c.Json | ConvertTo-Json -Compress })"
}
$e = { param($rootArg) }

"== 0. fresh install, then test records"
RunCli @('stop','--no-backup') | Out-Null
Remove-Item (Split-Path $Data) -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $Data, $Backups | Out-Null
$cfgFile = "$Root\config\shop.json"; $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
if (-not $cfg.pin) { $cfg | Add-Member pin '7575' -Force; [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false))) }
RunCli @('start','--no-open') | ForEach-Object { "   $_" } | Select-Object -Last 3; Up; Login; if (-not $script:tok) { 'the app did not come up - stopping'; exit 2 }
$svc0 = Services
MakeTestData
Check 'test data exists' ((Total '/api/invoices?limit=1&txnType=sale_invoice') -eq 2 -and (@(Tyres).Count -eq 2)) "(bills $(Total '/api/invoices?limit=1&txnType=sale_invoice'), tyres $(@(Tyres).Count), services $svc0)"
$brBefore = (Api 'GET' '/api/branches' $null).Json[0]; $phoneBefore = $brBefore.domainConfig.business_phone

"== 1. erase everything (option 1)"
$before = @(Get-ChildItem $Backups -Filter '*.dump').Count
$out = RunCli @('reset-data','--yes'); ($out | Where-Object { $_ -match '->|erased|Shop:' } | ForEach-Object { "   $_" })
Check 'the reset ran to the end' (($out -join "`n") -match 'Test data erased')
Check 'a safety backup was taken first' (@(Get-ChildItem $Backups -Filter '*.dump').Count -gt $before)
RunCli @('start','--no-open') | Out-Null; Up; Login
Check 'same login still works' ([bool]$script:tok)
Check 'bills are gone' ((Total '/api/invoices?limit=1') -eq 0)
Check 'customers and suppliers are gone' ((Total '/api/parties?limit=1') -eq 0)
Check 'the tyre list is gone' (@(Tyres).Count -eq 0)
Check 'the service list is kept' ((Services) -eq $svc0) "($(Services) services)"
$br = (Api 'GET' '/api/branches' $null).Json[0]
Check "the shop's settings are kept (name, GST, bill books, phone)" (($br.name -eq $brBefore.name) -and ($br.gstin -eq $brBefore.gstin) -and ($br.domainConfig.business_phone -eq $phoneBefore) -and ($br.domainConfig.bill_series.car.start -eq 93)) "($($br.name), $($br.gstin), car start $($br.domainConfig.bill_series.car.start))"

"== 2. the bill numbers start again from the book's numbers - and can be changed first"
$null = Api 'POST' '/api/tyre/import/products' '{"dryRun":false,"rows":[{"brand":"Yokohama","pattern":"BluEarth","size":"215/60 R16","kind":"tyre","vehicleType":"car","salePrice":9000,"gstRate":18,"hsn":"4011","stock":5}]}'
$car = (Tyres | Select-Object -First 1).id
$b1 = Api 'POST' '/api/tyre/sales' ('{"billSeries":"car","customer":{"name":"First Real","phone":"9811100010"},"items":[{"productId":"' + $car + '","qty":1}],"payments":[]}')
Check 'first car bill after the erase is 93 again' ($b1.Json.invoice.number -eq '93') "(got $($b1.Json.invoice.number))"
"   (then: erase again, set the car book to start at 250 in My Business & Staff, and bill)"
RunCli @('reset-data','--yes') | Out-Null; RunCli @('start','--no-open') | Out-Null; Up; Login
$brId = (Api 'GET' '/api/branches' $null).Json[0].id
$p = Api 'PATCH' "/api/branches/$brId" '{"domainConfig":{"bill_series":{"car":{"prefix":"","start":250},"two_wheel":{"prefix":"2W-","start":9}}}}'
Check 'the start numbers can be changed in settings' ($p.Code -eq 200)
$null = Api 'POST' '/api/tyre/import/products' '{"dryRun":false,"rows":[{"brand":"Yokohama","pattern":"BluEarth","size":"215/60 R16","kind":"tyre","vehicleType":"car","salePrice":9000,"gstRate":18,"hsn":"4011","stock":5}]}'
$car = (Tyres | Select-Object -First 1).id
$b2 = Api 'POST' '/api/tyre/sales' ('{"billSeries":"car","customer":{"name":"Second","phone":"9811100011"},"items":[{"productId":"' + $car + '","qty":1}],"payments":[]}')
Check 'the next car bill follows the new start (250)' ($b2.Json.invoice.number -eq '250') "(got $($b2.Json.invoice.number))"

"== 3. erase but keep the tyre list (option 2)"
MakeTestData
$out = RunCli @('reset-data','--yes','--keep-items'); ($out | Where-Object { $_ -match '->|Shop:' } | ForEach-Object { "   $_" })
RunCli @('start','--no-open') | Out-Null; Up; Login
Check 'bills and customers are gone' (((Total '/api/invoices?limit=1') -eq 0) -and ((Total '/api/parties?limit=1') -eq 0))
$t = Tyres
Check 'the tyre list is kept' ($t.Count -ge 2) "($($t.Count) tyres)"
Check 'stock is back to 0' ((@($t | Where-Object { [double]$_.stock -ne 0 }).Count) -eq 0)
Check 'services kept' ((Services) -eq $svc0)

"== 4. refuses without confirmation, and leaves everything alone"
MakeTestData
RunCli @('stop','--no-backup') | Out-Null
$o = RunCli @('reset-data'); Check 'no --yes: refused' (($o -join ' ') -match 'ERASES')
RunCli @('start','--no-open') | Out-Null; Up; Login
Check 'data untouched' ((Total '/api/invoices?limit=1') -ge 2)
RunCli @('stop','--no-backup') | Out-Null
""; if ($script:fail -eq 0) { 'ALL PASS' } else { "$($script:fail) FAILED" }
