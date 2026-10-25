@echo off
title Twisha POS - stop (with a backup)
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" stop
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Stopped. Your data and the backup are safe. )
echo.
pause
