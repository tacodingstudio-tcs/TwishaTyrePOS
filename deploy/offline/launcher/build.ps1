# Builds TwishaPOS.exe with the C# compiler that ships with Windows (.NET Framework 4) — no SDK required.
#   powershell -ExecutionPolicy Bypass -File deploy\offline\launcher\build.ps1 [-Out <folder>]
param([string]$Out = (Join-Path $PSScriptRoot 'out'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
New-Item -ItemType Directory -Force $Out | Out-Null
$manifest = Join-Path $Out 'app.manifest'
@'
<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2"><security><requestedPrivileges xmlns="urn:schemas-microsoft-com:asm.v3">
    <requestedExecutionLevel level="asInvoker" uiAccess="false" /></requestedPrivileges></security></trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware></windowsSettings></application>
</assembly>
'@ | Set-Content -Encoding UTF8 $manifest
& $csc /nologo /target:winexe /optimize+ "/out:$Out\TwishaPOS.exe" "/win32icon:$PSScriptRoot\twisha.ico" "/win32manifest:$manifest" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll "$PSScriptRoot\TwishaPOS.cs"
if ($LASTEXITCODE -ne 0) { throw "compile failed" }
Remove-Item $manifest
"built $Out\TwishaPOS.exe ($([math]::Round((Get-Item $Out\TwishaPOS.exe).Length/1KB)) KB)"
