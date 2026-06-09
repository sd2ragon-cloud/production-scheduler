@echo off
REM ===========================================================
REM  Single Startup launcher. Register ONLY this file's shortcut
REM  in shell:startup (or point Startup straight at start-server.bat).
REM  It opens the server window; the server batch itself also opens
REM  the auto-update window, so both windows always appear.
REM  NOTE: ASCII-only. chcp 65001 + non-ASCII bytes corrupts cmd parsing.
REM ===========================================================
start "production server" "%~dp0start-server.bat"
exit
