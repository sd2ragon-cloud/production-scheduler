@echo off
cd /d C:\production-scheduler
REM Looping server launcher. Absolute paths only, so it also works when copied into the
REM Windows Startup folder. If the server is killed (e.g. by a deploy restart), it comes
REM back in 5s. The auto-update window is started separately by the HKCU Run key "ps-auto-update".
:loop
call npm run start -- -H 0.0.0.0 -p 3000
echo.
echo [%date% %time%] server stopped. restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
