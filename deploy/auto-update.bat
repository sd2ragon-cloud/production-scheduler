@echo off
chcp 65001 >nul
title 자동 업데이트 (GitHub 감시)
REM [노트북 시작프로그램용] GitHub 자동 업데이트 감시 실행
REM ExecutionPolicy Bypass: 자동 업데이트가 ps1 자신을 GitHub zip에서 덮어쓰면
REM   파일에 MOTW(Mark-of-the-Web)가 붙어 RemoteSigned 정책이 실행을 거부한다.
REM   Bypass는 MOTW를 무시하므로 재부팅 후에도 항상 실행된다.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-update.ps1"
REM ps1 루프는 정상이면 끝나지 않는다. 여기 도달하면 비정상 종료이므로 창을 닫지 말고 보여준다.
echo.
echo [자동 업데이트가 종료되었습니다 - 위 오류 메시지를 확인하세요]
pause
