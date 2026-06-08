# [노트북에서 상시 실행] 배포 신호(deploy.signal)가 바뀌면 자동으로 재빌드 + 서버 재시작.
# 서버 자체는 2-start-server.bat 의 자동재시작 루프가 담당하므로,
# 여기서는 '빌드 후 서버 프로세스를 종료'만 하면 루프가 새 빌드로 다시 띄운다.
$ErrorActionPreference = "Continue"
$proj   = Split-Path $PSScriptRoot -Parent
$signal = Join-Path $PSScriptRoot "deploy.signal"
$last   = if (Test-Path $signal) { Get-Content $signal -Raw } else { "" }

Write-Host "[배포 감시 시작] $signal (10초 간격)"
while ($true) {
  try {
    if (Test-Path $signal) {
      $cur = Get-Content $signal -Raw
      if ($cur -ne $last) {
        $last = $cur
        Write-Host "[$(Get-Date -Format HH:mm:ss)] 새 배포 감지 -> 적용 시작"
        Set-Location $proj
        & cmd /c "npm install"
        & cmd /c "npm run build"
        # 3000 포트의 서버 프로세스 종료 -> start-server 루프가 새 빌드로 자동 재시작
        $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
        Write-Host "[$(Get-Date -Format HH:mm:ss)] 적용 완료 (서버 재시작됨)"
      }
    }
  } catch {
    Write-Host "[감시 오류] $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 10
}
