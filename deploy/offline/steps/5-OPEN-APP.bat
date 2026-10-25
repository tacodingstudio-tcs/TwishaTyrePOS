@echo off
title Step 5 of 5 - Open Twisha POS
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" open
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Twisha POS is open. Sign in with the owner mobile number and PIN. )
echo.
pause
