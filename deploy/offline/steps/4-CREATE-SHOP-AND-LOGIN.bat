@echo off
title Step 4 of 5 - Create the shop and the login
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" shop
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Step 4 done. Next: double-click 5-OPEN-APP.bat )
echo.
pause
