@echo off
chcp 65001 >nul
REM [노트북 시작프로그램용] GitHub 자동 업데이트 감시 실행
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0auto-update.ps1"
