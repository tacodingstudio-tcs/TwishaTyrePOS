@echo off
title Step 2 of 5 - Set up the database
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" db
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Step 2 done. Next: double-click 3-START-SERVICES.bat )
echo.
pause
