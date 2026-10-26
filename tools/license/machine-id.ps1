# Prints this PC's Machine ID (same value the app shows). Right-click > Run with PowerShell, or:
#   powershell -ExecutionPolicy Bypass -File machine-id.ps1
$g = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
$b = Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
$s = "twl1|$g|$($b.SystemManufacturer)|$($b.SystemProductName)|$($b.BaseBoardProduct)"
$h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Replace('-', '').Substring(0, 20)
$id = ($h -replace '(.{5})(?=.)', '$1-')
Write-Host ""
Write-Host "Machine ID:  $id" -ForegroundColor Green
Write-Host ""
Set-Clipboard -Value $id
Write-Host "(copied - paste it in WhatsApp)"
