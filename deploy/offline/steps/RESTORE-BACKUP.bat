@echo off
title Twisha POS - restore a backup
cd /d "%~dp0"
echo.
echo   This REPLACES everything in Twisha POS with the backup you choose.
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" restore
echo.
set /p FILE=Paste the full path of the backup file (from the list above) and press Enter: 
set /p SURE=Type YES to replace everything with that backup: 
if /i "%SURE%"=="YES" "%~dp0node\node.exe" "%~dp0scripts\cli.mjs" restore "%FILE%" --yes
echo.
pause
