# [Run on laptop, always] Poll GitHub(master) every 20s via the commits Atom feed. On a new commit:
#   download -> sync code -> (npm install only if deps changed) -> build -> restart server.
# Public repo so no git/token needed. data/, .next, node_modules are never touched.
# NOTE: we read the latest SHA from the Atom feed (github.com), NOT the REST API
#   (api.github.com), because the unauthenticated REST API is capped at 60 req/hour per IP
#   and 20s polling (180/hour) exhausts it, stalling updates. The Atom feed is not under that cap.
$ErrorActionPreference = "Continue"
$proj    = "C:\production-scheduler"
$repo    = "sd2ragon-cloud/production-scheduler"
$branch  = "master"
$shaFile = Join-Path $proj ".last_sha"
$headers = @{ "User-Agent" = "ps-auto-update" }
$lastSha = if (Test-Path $shaFile) { (Get-Content $shaFile -Raw).Trim() } else { "" }

Set-Location $proj
Write-Host "[auto-update started] $repo ($branch) - checking every 20s"

# Keep the boot server launcher (in the user's Startup folder) as the looping version,
# so a deploy that kills the server never leaves it down until a manual restart. Idempotent.
try {
  $startupDir = [Environment]::GetFolderPath('Startup')
  $srcLauncher = Join-Path $PSScriptRoot "start-server.bat"
  if ((Test-Path $startupDir) -and (Test-Path $srcLauncher)) {
    Copy-Item $srcLauncher (Join-Path $startupDir "start-server.bat") -Force
    Write-Host "[auto-update] synced Startup\start-server.bat to the looping launcher"
  }
} catch { Write-Host "[auto-update] startup launcher sync skipped: $($_.Exception.Message)" }

function Get-LockHash {
  $p = Join-Path $proj "package-lock.json"
  if (Test-Path $p) { (Get-FileHash $p -Algorithm MD5).Hash } else { "" }
}

while ($true) {
  try {
    $atom = (Invoke-WebRequest -Uri "https://github.com/$repo/commits/$branch.atom" -Headers $headers -TimeoutSec 30 -UseBasicParsing).Content
    $m = [regex]::Match($atom, 'Grit::Commit/([0-9a-f]{40})')
    if (-not $m.Success) { $m = [regex]::Match($atom, 'commit/([0-9a-f]{40})') }
    $sha = if ($m.Success) { $m.Groups[1].Value } else { "" }
    if ($sha -and $sha -ne $lastSha) {
      $short = $sha.Substring(0,7)
      Write-Host "[$(Get-Date -Format HH:mm:ss)] new version $short - applying"
      $zip = Join-Path $env:TEMP "ps-update.zip"
      $ext = Join-Path $env:TEMP "ps-update"
      Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" -OutFile $zip -Headers $headers -TimeoutSec 180 -UseBasicParsing
      if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
      Expand-Archive -Path $zip -DestinationPath $ext -Force
      $src = Join-Path $ext "production-scheduler-$branch"

      $lockBefore = Get-LockHash
      foreach ($d in @("src", "public", "deploy")) {
        $from = Join-Path $src $d
        if (Test-Path $from) { robocopy $from (Join-Path $proj $d) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
      }
      foreach ($f in @("package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs")) {
        $from = Join-Path $src $f
        if (Test-Path $from) { Copy-Item $from $proj -Force }
      }
      $lockAfter = Get-LockHash

      if ($lockBefore -ne $lockAfter) {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] dependencies changed - running npm install"
        & cmd /c "npm install"
      }
      & cmd /c "npm run build"

      $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
      foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }

      Set-Content -Path $shaFile -Value $sha -Encoding ascii
      $lastSha = $sha
      Write-Host "[$(Get-Date -Format HH:mm:ss)] done - server restarted ($short)"
    }
  } catch {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] check error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 20
}
