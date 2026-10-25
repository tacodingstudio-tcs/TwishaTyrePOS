@echo off
title Step 1 of 5 - Check this laptop
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" check
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Step 1 done. Next: double-click 2-SETUP-DATABASE.bat )
echo.
pause
