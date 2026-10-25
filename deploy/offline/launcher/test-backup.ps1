# Backup.exe and the backup places: default folder, a chosen folder, a second copy on a "pen drive", the drive missing,
# with the app closed and with the app running.
#   powershell -ExecutionPolicy Bypass -File test-backup.ps1 -Root <installed folder> -Data <data folder>
param([string]$Root = 'E:\HisabKitab\_test\TwishaPOS', [string]$Data = 'E:\HisabKitab\_test\data', [string]$Work = 'E:\HisabKitab\_test\bk')
$env:TWISHA_DATA = $Data; $env:TWISHA_NO_BROWSER = '1'
Remove-Item Env:TWISHA_BACKUPS -ErrorAction SilentlyContinue
$default = Join-Path $Work 'default'; $env:TWISHA_DEFAULT_BACKUPS = $default
$main = Join-Path $Work 'laptop-folder'; $usb = Join-Path $Work 'usb\TwishaPOS Backups'
Remove-Item "$Data\backup-settings.json" -ErrorAction SilentlyContinue   # every run starts with nothing chosen
Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $Work, "$Work\usb" | Out-Null
$script:fail = 0
function Check($name, $ok, $extra = '') { if ($ok) { "PASS  $name $extra" } else { "FAIL  $name $extra"; $script:fail++ } }
function CountDumps($f) { if (Test-Path $f) { (Get-ChildItem $f -Filter 'TwishaPOS-*.dump' -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 } }
function FirstDump($f) { Get-ChildItem $f -Filter 'TwishaPOS-*.dump' | Sort-Object Name | Select-Object -First 1 }
# Backup.exe is a window program: always wait for it, or two calls race each other
function SetSetting($name, $value) { Start-Process "$Root\Backup.exe" -ArgumentList $name, "`"$value`"" -Wait -WindowStyle Hidden }
function Backup {
  $out = Join-Path $Work 'out.txt'; Remove-Item $out -ErrorAction SilentlyContinue
  $p = Start-Process "$Root\Backup.exe" -ArgumentList '--now', '--out', "`"$out`"" -Wait -PassThru -WindowStyle Hidden
  [pscustomobject]@{ Code = $p.ExitCode; Text = (Get-Content $out -Raw -ErrorAction SilentlyContinue) }
}
function PgUp { [bool](Get-Process postgres -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Root\*" }) }
function Short($t) { (($t -replace '\s+', ' ').Trim()) }

& "$Root\TwishaPOS.exe" --stop 2>&1 | Out-Null; Start-Sleep 2

"== 1. app closed, nothing chosen: goes to the default folder"
$r = Backup; Check 'backup works with the app closed' ($r.Code -eq 0) (Short $r.Text)
Check 'file is in the default folder' ((CountDumps $default) -eq 1)
Check 'the database was only started for the backup (stopped again)' (-not (PgUp))

"== 2. a folder on the laptop + a second copy on a pen drive"
SetSetting '--set-folder' $main; SetSetting '--set-copy' $usb
$s = Get-Content "$Data\backup-settings.json" -Raw | ConvertFrom-Json
Check 'both settings were saved' (($s.folder -eq $main) -and ($s.copyTo -eq $usb)) ($s | ConvertTo-Json -Compress)
$r = Backup
Check 'backup ok' ($r.Code -eq 0)
Check 'saved in the chosen folder' ((CountDumps $main) -eq 1)
Check 'copied to the pen drive' ((CountDumps $usb) -eq 1)
Check 'the two files are identical' ((Get-FileHash (FirstDump $main).FullName).Hash -eq (Get-FileHash (FirstDump $usb).FullName).Hash)
Check 'the message says so' ($r.Text -match 'Also copied')

"== 3. the pen drive is not plugged in"
SetSetting '--set-copy' 'Z:\TwishaPOS Backups'
$r = Backup
Check 'the backup still succeeds' ($r.Code -eq 0)
Check 'saved on the laptop anyway' ((CountDumps $main) -eq 2)
Check 'the user is told the copy could not be made' ($r.Text -match 'Could not copy') (Short (($r.Text -split "`n" | Where-Object { $_ -match 'Could not copy' } | Select-Object -First 1)))
Check 'nothing was created on the missing drive' (-not (Test-Path 'Z:\'))

"== 4. the chosen folder itself is on a drive that is gone: fall back to the default"
SetSetting '--set-folder' 'Z:\Backups'; SetSetting '--set-copy' 'none'
$before = CountDumps $default; $r = Backup
Check 'backup succeeds' ($r.Code -eq 0)
Check 'went to the default folder instead' ((CountDumps $default) -eq $before + 1)
Check 'the user is told' ($r.Text -match 'not available') (Short (($r.Text -split "`n" | Where-Object { $_ -match 'not available' } | Select-Object -First 1)))

"== 5. with the app RUNNING: nothing is disturbed"
SetSetting '--set-folder' $main; SetSetting '--set-copy' $usb
Start-Process "$Root\TwishaPOS.exe" -WorkingDirectory $Root
$sw = [Diagnostics.Stopwatch]::StartNew(); while ((& curl.exe -s -m 2 -o NUL -w '%{http_code}' http://127.0.0.1:4470/health) -ne '200' -and $sw.Elapsed.TotalSeconds -lt 90) { Start-Sleep -Milliseconds 400 }
Start-Sleep 4
$n0 = CountDumps $main; $u0 = CountDumps $usb; $r = Backup
Check 'backup ok while the app is running' ($r.Code -eq 0) (Short $r.Text)
Check 'one more file in the folder and on the pen drive' (((CountDumps $main) -eq $n0 + 1) -and ((CountDumps $usb) -eq $u0 + 1))
Check 'the app is still up' ((& curl.exe -s -m 3 -o NUL -w '%{http_code}' http://127.0.0.1:4470/health) -eq '200')
Check 'the database was NOT stopped by the backup' (PgUp)

"== 6. quitting also backs up to both places"
$a = CountDumps $main; $b = CountDumps $usb
Start-Process "$Root\TwishaPOS.exe" -ArgumentList '--stop' -Wait -WindowStyle Hidden
Check 'quit made a backup in the chosen folder' ((CountDumps $main) -eq $a + 1)
Check 'and on the pen drive' ((CountDumps $usb) -eq $b + 1)
Check 'the restore list reads the chosen folder' ((& "$Root\node\node.exe" "$Root\scripts\cli.mjs" restore 2>&1 | Out-String) -match [regex]::Escape($main))
""; if ($script:fail -eq 0) { 'ALL PASS' } else { "$($script:fail) FAILED" }
