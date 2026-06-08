@echo off
chcp 65001 >nul
REM ===========================================================
REM  [이 PC(작업용)에서 실행] 수정한 소스를 노트북으로 배포한다.
REM  아래 노트북 공유 경로를 본인 환경에 맞게 한 번만 수정하세요.
REM  예: \\PRODUCTION-PC\production-scheduler
set "LAPTOP=\\노트북컴퓨터이름\production-scheduler"
REM ===========================================================

cd /d "%~dp0.."

if not exist "%LAPTOP%\" (
  echo [오류] 노트북 공유 폴더에 접근할 수 없습니다: %LAPTOP%
  echo  - 노트북이 켜져 있는지
  echo  - 노트북에서 production-scheduler 폴더를 '공유'했는지
  echo  - 위 LAPTOP 경로가 맞는지 확인하세요.
  pause & exit /b 1
)

echo 소스 복사 중...  (데이터/빌드 폴더는 건드리지 않음)
robocopy src    "%LAPTOP%\src"    /MIR /NFL /NDL /NJH /NJS /NP
robocopy public "%LAPTOP%\public" /MIR /NFL /NDL /NJH /NJS /NP
copy /Y package.json        "%LAPTOP%\" >nul
copy /Y package-lock.json   "%LAPTOP%\" >nul
copy /Y next.config.ts      "%LAPTOP%\" >nul
copy /Y tsconfig.json       "%LAPTOP%\" >nul
copy /Y postcss.config.mjs  "%LAPTOP%\" >nul
copy /Y eslint.config.mjs   "%LAPTOP%\" >nul

REM 배포 신호 갱신 -> 노트북 감시 프로그램이 약 10초 내 자동 빌드+재시작
echo %date% %time% > "%LAPTOP%\deploy\deploy.signal"

echo.
echo 배포 완료! 노트북이 약 10초 내 자동으로 빌드 후 재시작합니다.
echo (적용 상황은 노트북의 감시 창에서 확인할 수 있습니다)
pause
