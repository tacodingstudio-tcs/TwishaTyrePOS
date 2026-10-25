@echo off
title Step 3 of 5 - Start the services
cd /d "%~dp0"
echo.
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" services
echo.
if errorlevel 1 ( echo   Something needs attention - read the lines above, fix it, and run this file again. ) else ( echo   Step 3 done. Next: double-click 4-CREATE-SHOP-AND-LOGIN.bat )
echo.
pause
