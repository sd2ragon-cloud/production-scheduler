@echo off
chcp 65001 >nul
title 시작프로그램 등록
REM ===========================================================
REM  [노트북에서 한 번만 더블클릭] 부팅 자동시작을 startup.bat 하나로 정리한다.
REM   - 서버창만 뜨고 업데이트창이 안 뜨던 문제(옛 개별 바로가기 잔재)를 청소하고
REM   - startup.bat 바로가기 단 하나만 시작프로그램에 남긴다.
REM   - 이후 부팅하면 서버창 + 자동 업데이트창이 항상 함께 뜬다.
REM ===========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-startup.ps1"
echo.
pause
