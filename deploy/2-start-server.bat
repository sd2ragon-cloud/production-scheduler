@echo off
chcp 65001 >nul
REM === 생산스케줄링 서버 (운영 모드). 꺼지면 자동 재시작 ===
cd /d "%~dp0.."
REM Ride on the server autostart to also open the auto-update window.
REM This guarantees the update window appears even if the Startup shortcut for it is missing.
start "auto-update" "%~dp0auto-update.bat"
:loop
echo [%date% %time%] 서버 시작 (http://0.0.0.0:3000)
call npm run start -- -H 0.0.0.0 -p 3000
echo.
echo [%date% %time%] 서버가 멈췄습니다. 5초 후 자동 재시작...
timeout /t 5 /nobreak >nul
goto loop
