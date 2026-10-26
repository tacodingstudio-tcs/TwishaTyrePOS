@echo off
title Twisha POS - find out why it starts slowly
cd /d "%~dp0"
echo.
echo   Measuring this laptop (about 1 minute). Nothing is changed.
echo   For the best result: restart the laptop, then run this FIRST, before opening other programs.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0DIAGNOSE-SLOW-START.ps1"
echo.
pause
