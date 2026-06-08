# [노트북에서 한 번만 실행] startup.bat를 시작프로그램(Startup)에 '단 하나'로 등록한다.
#   왜? 예전에는 서버용/업데이트용 바로가기를 따로 등록해서, 한쪽(업데이트)이 누락되면
#   부팅 시 서버창만 뜨고 업데이트창은 안 뜨는 사고가 났다.
#   이 스크립트는 우리 런처를 가리키는 옛 바로가기들을(이름과 무관하게) 모두 정리하고,
#   startup.bat 바로가기 하나만 남긴다. startup.bat은 부팅 시 서버창+업데이트창을 함께 띄운다.
$ErrorActionPreference = 'Stop'

$deploy     = $PSScriptRoot
$startupBat = Join-Path $deploy 'startup.bat'
if (-not (Test-Path $startupBat)) { throw "startup.bat를 찾을 수 없습니다: $startupBat" }

$startupDir = [Environment]::GetFolderPath('Startup')
$wsh        = New-Object -ComObject WScript.Shell
# 우리 런처들. 시작프로그램에 이걸 가리키는 바로가기가 있으면 정리 대상.
$ourLeaves  = @('start-server.bat', 'auto-update.bat', '2-start-server.bat', 'startup.bat')

Write-Host "시작프로그램 폴더 : $startupDir"
Write-Host "런처            : $startupBat"
Write-Host ""

# 1) 우리 런처를 가리키는 기존 바로가기를 모두 제거 (.lnk 파일명이 무엇이든 대상 경로로 판별)
$removed = 0
Get-ChildItem -Path $startupDir -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $target = $wsh.CreateShortcut($_.FullName).TargetPath
    if ($target) {
      $leaf = Split-Path $target -Leaf
      if ($ourLeaves -contains $leaf) {
        Remove-Item $_.FullName -Force
        Write-Host ("기존 시작항목 제거 : {0,-40} (-> {1})" -f $_.Name, $leaf)
        $removed++
      }
    }
  } catch { }
}
if ($removed -eq 0) { Write-Host "정리할 기존 시작항목 없음" }

# 2) startup.bat 바로가기 하나만 새로 만든다 (있으면 덮어쓴다 = 멱등)
$lnk = Join-Path $startupDir '생산스케줄 자동시작.lnk'
$s = $wsh.CreateShortcut($lnk)
$s.TargetPath       = $startupBat
$s.WorkingDirectory = $deploy
$s.WindowStyle      = 7          # 런처는 최소화로 실행(두 창만 띄우고 즉시 종료하므로 깜빡임 방지)
$s.Description      = '생산스케줄 서버 + 자동 업데이트 동시 시작'
$s.Save()

Write-Host ""
Write-Host "단일 런처 등록 완료 : $lnk"
Write-Host ""
Write-Host "끝났습니다. 노트북을 재부팅해서 '서버 창'과 '자동 업데이트 창'이 둘 다 뜨는지 확인하세요."
