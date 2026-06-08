@echo off
chcp 65001 >nul
REM === 최초 1회: 의존성 설치 + 운영 빌드 ===
cd /d "%~dp0.."
echo [1/2] 의존성 설치 중... (시간이 좀 걸립니다)
call npm install
if errorlevel 1 ( echo 설치 실패 & pause & exit /b 1 )
echo [2/2] 운영 빌드 중...
call npm run build
if errorlevel 1 ( echo 빌드 실패 & pause & exit /b 1 )
echo.
echo 완료! 이제 2-start-server.bat 로 서버를 시작하세요.
pause
