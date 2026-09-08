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

# Read `tailscale ... --json`, and SAY WHY when it fails.
# The previous version swallowed stderr (2>$null) and every exception, so when
# `tailscale status --json` returned nothing the log only showed backend='' with no reason --
# the watchdog then ran 'tailscale up' every 5 minutes and never refreshed tunnel-url.txt.
# Tailscale's local API rejects callers that are not elevated, which is the usual cause here
# (see the -RunLevel Highest task registration below).
$script:tsErrLogged = $false
function TsJson($cliArgs) {
  $errFile = Join-Path $env:TEMP ("ts-" + [guid]::NewGuid().ToString("N") + ".err")
  try {
    $out = & cmd.exe /c ('"' + $ts + '" ' + $cliArgs + ' 2>"' + $errFile + '"') | Out-String
    if ($out -and $out.Trim()) { return ($out | ConvertFrom-Json) }
    if (-not $script:tsErrLogged) {
      $script:tsErrLogged = $true
      $e = ""
      try { if (Test-Path $errFile) { $e = (Get-Content $errFile -Raw).Trim() } } catch {}
      if (-not $e) { $e = "(no stderr)" }
      Log ("tailscale '" + $cliArgs + "' gave no JSON -- stderr: " + $e)
    }
  } catch {
    if (-not $script:tsErrLogged) {
      $script:tsErrLogged = $true
      Log ("tailscale '" + $cliArgs + "' error: " + $_.Exception.Message)
    }
  } finally {
    try { if (Test-Path $errFile) { Remove-Item $errFile -Force -ErrorAction SilentlyContinue } } catch {}
  }
  return $null
}

# 1) Self-register the scheduled task (every 5 min) if it is missing.
try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  # Re-register an existing task that runs unelevated: `tailscale status --json` needs elevation,
  # and without it this watchdog is blind (backend always reads as '').
  if ($existing -and $existing.Principal.RunLevel -ne "Highest") {
    Log "existing task is not elevated -> re-registering with RunLevel Highest"
    $existing = $null
  }
  if (-not $existing) {
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                 -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $selfPath + "`"")
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
                 -RepetitionInterval (New-TimeSpan -Minutes 5) `
                 -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -User $env:USERNAME -RunLevel Highest `
      -Description "Keep Tailscale Funnel alive for production-scheduler (external access self-heal)" -Force | Out-Null
    Log "registered scheduled task '$taskName' (every 5 min, elevated)"
  }
} catch { Log ("task register error: " + $_.Exception.Message) }

# 2) Ensure the Tailscale backend is Running; reconnect if not.
$state = ""
$st = TsJson "status --json"
if ($st) { $state = [string]$st.BackendState }
if ($state -ne "Running") {
  Log ("tailscale backend='" + $state + "' -> running 'tailscale up'")
  try { & cmd.exe /c ('"' + $ts + '" up 2>NUL') | Out-Null } catch { Log ("tailscale up error: " + $_.Exception.Message) }
  Start-Sleep -Seconds 3
  $st = TsJson "status --json"
  if ($st) { $state = [string]$st.BackendState }
}

# 3) (Re)assert the funnel on port 3000 (idempotent; persisted by tailscaled).
try { & cmd.exe /c ('"' + $ts + '" funnel --bg 3000 2>NUL') | Out-Null } catch { Log ("funnel assert error: " + $_.Exception.Message) }

# 4) Refresh tunnel-url.txt with the current public URL.
$url = ""
$st2 = TsJson "status --json"
if ($st2 -and $st2.Self -and $st2.Self.DNSName) { $url = "https://" + ([string]$st2.Self.DNSName).TrimEnd('.') }
if ($url) {
  # A changed public URL means every shared bookmark just died - make that loud in the log.
  $prev = ""
  try { if (Test-Path $urlFile) { $prev = (Get-Content $urlFile -Raw -ErrorAction Stop).Trim() } } catch {}
  if ($prev -and $prev -ne $url) { Log ("PUBLIC URL CHANGED: " + $prev + " -> " + $url + " (old bookmarks are dead)") }
  try { Set-Content -Path $urlFile -Value $url -Encoding ascii } catch {}
}

# 5) Record (do not restart) if the app server is not listening on port 3000.
$serverUp = $true
try {
  $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if (-not $listening) { $serverUp = $false; Log "WARN: no server listening on port 3000" }
} catch {}

# 6) Keep the GitHub auto-update watcher alive.
# It runs from the HKCU Run key in a console window. If that window is closed -- or the script
# exits and cmd parks on its `pause` -- deploys stop silently: commits pile up on GitHub while
# the laptop keeps serving old code, and nothing on screen says so. That is exactly what
# happened on 2026-09-08 (two commits never reached the server). Launch the ps1 directly rather
# than auto-update.bat, so a failing run cannot leave a cmd window stuck on `pause`.
$autoUp = $true
try {
  $running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and $_.CommandLine -match 'auto-update\.ps1' }
  if (-not $running) {
    $autoUp = $false
    $ps1 = Join-Path $deployDir "auto-update.ps1"
    if (Test-Path $ps1) {
      Log "auto-update watcher is NOT running -> restarting it (deploys were stalled)"
      Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ps1) `
        -WorkingDirectory $proj -WindowStyle Minimized
    } else {
      Log ("WARN: auto-update watcher not running and " + $ps1 + " is missing")
    }
  }
} catch { Log ("auto-update check error: " + $_.Exception.Message) }

Log ("ok backend='" + $state + "' serverUp=" + $serverUp + " autoUpdate=" + $autoUp + " url='" + $url + "'")
