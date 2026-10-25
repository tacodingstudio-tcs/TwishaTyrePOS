@echo off
title Twisha POS - ERASE TEST DATA
cd /d "%~dp0"
echo.
echo   ============================================================
echo    ERASE TEST DATA  -  for handing the shop over clean
echo   ============================================================
echo.
echo   This ERASES every bill, quotation, customer, supplier, stock entry,
echo   warranty card, vehicle, expense, team record and WhatsApp message.
echo.
echo   KEPT:  the shop's settings (name, address, GST number, bill numbers),
echo          the login (mobile number and PIN), the list of services.
echo   A safety backup of everything is taken first.
echo.
echo     1   Erase everything, including the tyre list
echo     2   Erase everything but KEEP the tyre list (stock goes back to 0)
echo     Q   Cancel
echo.
set /p CHOICE=  Type 1, 2 or Q and press Enter:
set OPT=
if /i "%CHOICE%"=="1" goto CONFIRM
if /i "%CHOICE%"=="2" ( set OPT=--keep-items & goto CONFIRM )
echo.
echo   Cancelled - nothing was changed.
goto END
:CONFIRM
echo.
set /p SURE=  Type ERASE (capital letters) to confirm:
if not "%SURE%"=="ERASE" ( echo. & echo   Cancelled - nothing was changed. & goto END )
echo.
echo   Closing Twisha POS ...
start "" /wait "%~dp0TwishaPOS.exe" --stop
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" reset-data --yes %OPT%
echo.
if errorlevel 1 ( echo   Something went wrong - nothing was erased. Read the lines above. ) else ( echo   Done. Now double-click the Twisha POS icon on the desktop. )
:END
echo.
pause
