@echo off
REM === Production scheduler server (prod mode). Auto-restarts if it stops. ===
REM NOTE: keep this file ASCII-only. chcp 65001 + non-ASCII bytes corrupts cmd batch parsing.
cd /d "%~dp0.."
REM Ride on the server autostart to also open the auto-update window.
start "auto-update" "%~dp0auto-update.bat"
:loop
echo [%date% %time%] server starting (http://0.0.0.0:3000)
call npm run start -- -H 0.0.0.0 -p 3000
echo.
echo [%date% %time%] server stopped. restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
