@echo off
cd /d C:\production-scheduler
REM Auto-update window is started separately by the HKCU Run key "ps-auto-update".
:loop
npm run start
timeout /t 5 >nul
goto loop
