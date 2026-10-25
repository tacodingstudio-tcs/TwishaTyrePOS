@echo off
title Twisha POS - lift the sign-in lock
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" unlock
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Done. Try signing in again. )
echo.
pause
