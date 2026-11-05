@echo off
title Twisha POS - LOAD THE OLD BILL BOOK
cd /d "%~dp0"
echo.
echo   ============================================================
echo    LOAD THE SHOP'S OLD BILL BOOK
echo   ============================================================
echo.
echo   Puts the bills of the paper / Excel bill book into the app, with their own
echo   bill numbers and dates, and creates the customers and vehicles from them.
echo   The bills are saved as paid. Stock is NOT changed.
echo.
echo   Safe to run twice: a bill number that is already in the app is skipped.
echo   First you see what will happen; nothing is saved until you type IMPORT.
echo.
echo   Run ERASE-TEST-DATA.bat first if the app still holds test bills.
echo.
echo   Closing Twisha POS ...
start "" /wait "%~dp0TwishaPOS.exe" --stop --no-backup
"%~dp0node\node.exe" "%~dp0scripts\cli.mjs" import-bill-book
echo.
echo   Now double-click the Twisha POS icon on the desktop.
echo.
pause
