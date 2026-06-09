@echo off
title auto-update (GitHub watch)
REM [laptop startup] Run the GitHub auto-update watcher.
REM ExecutionPolicy Bypass: when auto-update overwrites this ps1 from the GitHub zip,
REM   the file gets a Mark-of-the-Web and a RemoteSigned policy would refuse to run it.
REM   Bypass ignores MOTW, so it keeps running even after a reboot.
REM NOTE: keep this file ASCII-only. chcp 65001 + non-ASCII bytes corrupts cmd batch parsing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-update.ps1"
REM The ps1 loop never ends when healthy. Reaching here means it exited abnormally; keep the window open.
echo.
echo [auto-update has stopped - check the error messages above]
pause
