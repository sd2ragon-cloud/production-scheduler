# [노트북에서 상시 실행] GitHub(master)의 최신 커밋을 60초마다 확인.
# 새 버전이 올라오면: 코드 다운로드 → npm install → 빌드 → 서버 재시작 (자동).
# 공개(public) 저장소라 git/토큰 불필요. 데이터(data/)와 빌드(.next)/모듈(node_modules)은 건드리지 않음.
$ErrorActionPreference = "Continue"
$proj    = "C:\production-scheduler"
$repo    = "sd2ragon-cloud/production-scheduler"
$branch  = "master"
$shaFile = Join-Path $proj ".last_sha"            # 루트에 저장(동기화 대상 아님)
$headers = @{ "User-Agent" = "ps-auto-update" }
$lastSha = if (Test-Path $shaFile) { (Get-Content $shaFile -Raw).Trim() } else { "" }

Set-Location $proj
Write-Host "[자동 업데이트 감시 시작] $repo ($branch) — 60초 간격"

while ($true) {
  try {
    $sha = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/commits/$branch" -Headers $headers -TimeoutSec 30).sha
    if ($sha -and $sha -ne $lastSha) {
      Write-Host "[$(Get-Date -Format HH:mm:ss)] 새 버전 $($sha.Substring(0,7)) — 적용 시작"
      $zip = Join-Path $env:TEMP "ps-update.zip"
      $ext = Join-Path $env:TEMP "ps-update"
      Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" -OutFile $zip -Headers $headers -TimeoutSec 180
      if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
      Expand-Archive -Path $zip -DestinationPath $ext -Force
      $src = Join-Path $ext "production-scheduler-$branch"

      foreach ($d in @("src", "public", "deploy")) {
        $from = Join-Path $src $d
        if (Test-Path $from) { robocopy $from (Join-Path $proj $d) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
      }
      foreach ($f in @("package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs")) {
        $from = Join-Path $src $f
        if (Test-Path $from) { Copy-Item $from $proj -Force }
      }

      & cmd /c "npm install"
      & cmd /c "npm run build"

      # 3000 포트 서버 종료 → start-server 루프가 새 빌드로 자동 재시작
      $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
      foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }

      Set-Content -Path $shaFile -Value $sha -Encoding ascii
      $lastSha = $sha
      Write-Host "[$(Get-Date -Format HH:mm:ss)] 적용 완료 — 서버 재시작됨"
    }
  } catch {
    Write-Host "[확인 오류] $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 60
}
