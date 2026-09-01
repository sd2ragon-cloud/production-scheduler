# [Run on laptop] Ensure Tailscale Funnel publishes the scheduler (localhost:3000) on the
# node's PERMANENT https://<machine>.<tailnet>.ts.net URL, then write that URL to
# tunnel-url.txt so the app shows it (GET /api/tunnel + the NavBar external-access button).
#
# Tailscale's own service keeps the funnel alive across reboots; this one-shot script just
# (re)asserts the funnel and refreshes the URL file. Register it via an HKCU Run key
# named "ps-funnel" so it runs on each logon.
#
# One-time prereqs (see the external-access guide in deploy\): install Tailscale on the
# laptop, run `tailscale up`, then enable MagicDNS + HTTPS + Funnel in the admin console.
#
# ASCII ONLY: PowerShell 5.1 on this laptop mangles non-ASCII source files.

$ErrorActionPreference = "Continue"
$proj    = "C:\production-scheduler"
$urlFile = Join-Path $proj "tunnel-url.txt"

# Locate the tailscale CLI (PATH, or the default install dir).
$ts = "tailscale"
foreach ($c in @("C:\Program Files\Tailscale\tailscale.exe","C:\Program Files (x86)\Tailscale\tailscale.exe")) {
  if (Test-Path $c) { $ts = $c; break }
}

Write-Host "[funnel] asserting Tailscale Funnel for port 3000 ..."
# Idempotent; --bg runs in the background and is persisted by the tailscaled service.
try { & $ts funnel --bg 3000 2>&1 | Out-Host } catch { Write-Host "[funnel] assert error: $($_.Exception.Message)" }

# Capture the permanent public URL. Retry a few times because tailscaled may still be
# coming up right after a reboot when this runs from the Run key.
$url = ""
for ($i = 0; $i -lt 6 -and -not $url; $i++) {
  try {
    $json = & $ts status --json 2>$null | Out-String
    if ($json) {
      $dns = ($json | ConvertFrom-Json).Self.DNSName
      if ($dns) { $url = "https://" + $dns.TrimEnd('.') }
    }
  } catch {}
  if (-not $url) { Start-Sleep -Seconds 5 }
}

if (-not $url) {
  # Fallback: parse the textual `tailscale funnel status` output.
  try {
    $fs = & $ts funnel status 2>&1 | Out-String
    $m = [regex]::Match($fs, "https://[a-zA-Z0-9.-]+\.ts\.net")
    if ($m.Success) { $url = $m.Value }
  } catch {}
}

if ($url) {
  Set-Content -Path $urlFile -Value $url -Encoding ascii
  Write-Host "[funnel] PUBLIC URL = $url   (saved to tunnel-url.txt)"
} else {
  Write-Host "[funnel] could not determine the Tailscale URL. Is Tailscale 'up' and Funnel enabled?"
}

# Also run the funnel watchdog once. It self-registers a 5-min Scheduled Task that keeps
# Tailscale + Funnel alive, so external access self-heals without needing a reboot.
$wd = Join-Path $PSScriptRoot "funnel-watchdog.ps1"
if (Test-Path $wd) {
  try { & powershell -NoProfile -ExecutionPolicy Bypass -File $wd 2>&1 | Out-Host }
  catch { Write-Host "[funnel] watchdog launch error: $($_.Exception.Message)" }
}
