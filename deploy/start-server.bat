@echo off
cd /d C:\production-scheduler
REM Ride on the server autostart to also open the auto-update window.
REM This guarantees the update window appears even if the Startup shortcut for it is missing.
start "auto-update" "%~dp0auto-update.bat"
:loop
npm run start
timeout /t 5 >nul
goto loop
