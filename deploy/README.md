# 배포 / 자동시작 구조 (노트북 서버)

라이브 서버는 사무실 노트북(Windows 사용자 `세종생산센터`, 고정 IP 10.3.50.72)에서 24시간 동작하며, 팀은 `http://10.3.50.72:3000` 으로 접속한다.

## 자동 배포 흐름
1. 개발 PC에서 코드 수정 → 커밋 → GitHub `master`에 push.
2. 노트북의 **자동 업데이트 창**(`auto-update.ps1`)이 20초마다 master를 확인 → 새 커밋이 있으면 zip 다운로드 → `src` / `public` / `deploy` + 설정파일 동기화(데이터/빌드 폴더는 건드리지 않음) → 의존성 변경 시에만 `npm install` → `npm run build` → 3000포트 서버 프로세스 종료.
3. **서버 창**(루프)이 종료를 감지하고 5초 뒤 새 빌드로 자동 재시작. 약 1~2분 내 반영.
4. 적용된 커밋은 `C:\production-scheduler\.last_sha`에 기록되고 `GET /api/version`으로 확인 가능.

## 부팅 시 두 창 자동 실행 (둘은 서로 독립)
- **업데이트 창**: 레지스트리 Run 키 `HKCU\...\CurrentVersion\Run` 의 `ps-auto-update` → `deploy\auto-update.bat`.
  - 재등록: `reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ps-auto-update /t REG_SZ /d C:\production-scheduler\deploy\auto-update.bat /f`
- **서버 창**: 사용자 시작프로그램 폴더에 직접 들어있는 `start-server.bat` 파일.
  - 반드시 **루프형**이어야 한다(배포가 서버를 죽이면 루프만이 되살림). `deploy\start-server.bat`이 그 루프 런처이며, `auto-update.ps1`이 기동 시마다 시작프로그램의 사본을 이걸로 자가 동기화한다.
  - 수동 설치/복구: `copy /Y "C:\production-scheduler\deploy\start-server.bat" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\start-server.bat"`

## 주의사항
- **노트북에서 자동 실행되는 `.bat`는 반드시 ASCII 전용**(주석에도 한글 금지). `chcp 65001` + 한글이 섞이면 cmd 배치 파싱이 깨져 주석/문자열이 명령으로 실행되고 일부 줄이 누락된다.
- 콘솔 창은 클릭하면 멈춘다(QuickEdit). 서버 창을 클릭하면 사이트가 멈추니 주의.
- 라이브 DB(`data\production.db`)는 노트북에만 있고 git에 올라가지 않는다.
