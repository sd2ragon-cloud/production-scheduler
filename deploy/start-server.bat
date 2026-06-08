@echo off
cd /d C:\production-scheduler
:loop
npm run start
timeout /t 5 >nul
goto loop
