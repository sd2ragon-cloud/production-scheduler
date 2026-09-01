# [Run on laptop] Watchdog: keep Tailscale + Funnel alive so the external ts.net URL stays reachable
# without needing to reboot. Runs every 5 minutes via the Scheduled Task "ps-funnel-watchdog",
# which this script self-registers on its first run.
#
# Each run:
#   1) self-register the 5-min Scheduled Task (idempotent),
#   2) if the Tailscale backend is not "Running" -> `tailscale up` (reconnect),
#   3) (re)assert `tailscale funnel --bg 3000` (idempotent),
#   4) refresh tunnel-url.txt with the current public URL,
#   5) log a WARN line if the app server is not listening on port 3000 (the looping
#      start-server launcher handles the actual restart; here we only record it).
#
# ASCII ONLY: PowerShell 5.1 on this laptop mangles non-ASCII source files.

$ErrorActionPreference = "Continue"
$proj      = "C:\production-scheduler"
$urlFile   = Join-Path $proj "tunnel-url.txt"
$logFile   = Join-Path $proj "funnel-watchdog.log"
$deployDir = $PSScriptRoot
$taskName  = "ps-funnel-watchdog"
$selfPath  = Join-Path $deployDir "funnel-watchdog.ps1"

function Log($msg) {
  $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
  try { Add-Content -Path $logFile -Value $line -Encoding ascii } catch {}
}

# Keep the log small (truncate past ~200 KB).
try {
  if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 200000)) {
    Set-Content -Path $logFile -Value "" -Encoding ascii
  }
} catch {}

# Locate the tailscale CLI (PATH, or the default install dir).
$ts = "tailscale"
foreach ($c in @("C:\Program Files\Tailscale\tailscale.exe","C:\Program Files (x86)\Tailscale\tailscale.exe")) {
  if (Test-Path $c) { $ts = $c; break }
}

# 1) Self-register the scheduled task (every 5 min) if it is missing.
try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                 -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $selfPath + "`"")
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
                 -RepetitionInterval (New-TimeSpan -Minutes 5) `
                 -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -Description "Keep Tailscale Funnel alive for production-scheduler (external access self-heal)" -Force | Out-Null
    Log "registered scheduled task '$taskName' (every 5 min)"
  }
} catch { Log ("task register error: " + $_.Exception.Message) }

# 2) Ensure the Tailscale backend is Running; reconnect if not.
$state = ""
try {
  $json = & $ts status --json 2>$null | Out-String
  if ($json) { $state = ($json | ConvertFrom-Json).BackendState }
} catch {}
if ($state -ne "Running") {
  Log ("tailscale backend='" + $state + "' -> running 'tailscale up'")
  try { & $ts up 2>&1 | Out-Null } catch { Log ("tailscale up error: " + $_.Exception.Message) }
  Start-Sleep -Seconds 3
  try {
    $json = & $ts status --json 2>$null | Out-String
    if ($json) { $state = ($json | ConvertFrom-Json).BackendState }
  } catch {}
}

# 3) (Re)assert the funnel on port 3000 (idempotent; persisted by tailscaled).
try { & $ts funnel --bg 3000 2>&1 | Out-Null } catch { Log ("funnel assert error: " + $_.Exception.Message) }

# 4) Refresh tunnel-url.txt with the current public URL.
$url = ""
try {
  $json = & $ts status --json 2>$null | Out-String
  if ($json) {
    $dns = ($json | ConvertFrom-Json).Self.DNSName
    if ($dns) { $url = "https://" + $dns.TrimEnd('.') }
  }
} catch {}
if ($url) { try { Set-Content -Path $urlFile -Value $url -Encoding ascii } catch {} }

# 5) Record (do not restart) if the app server is not listening on port 3000.
$serverUp = $true
try {
  $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if (-not $listening) { $serverUp = $false; Log "WARN: no server listening on port 3000" }
} catch {}

Log ("ok backend='" + $state + "' serverUp=" + $serverUp + " url='" + $url + "'")
