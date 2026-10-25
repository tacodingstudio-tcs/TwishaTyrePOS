@echo off
title Twisha POS - start everything
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" start
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Twisha POS is running. Use STOP-TWISHA-POS.bat when you finish for the day. )
echo.
pause
