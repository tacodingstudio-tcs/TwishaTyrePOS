@echo off
title Twisha POS - set a new PIN
cd /d "%~dp0"
echo.
set /p NEWPIN=Type the NEW 4-digit PIN and press Enter: 
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" reset-pin %NEWPIN%
echo.
pause
