@echo off
title Twisha POS - back up now
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" backup
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Backup saved in Documents\TwishaPOS Backups. Copy that folder to a pen drive now and then. )
echo.
pause
