import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const pexec = promisify(exec);

// 운영 노트북 상태 진단(읽기 전용). 사내망/로컬에서만 응답하고, 공개 Funnel(ts.net)로는 404.
// Tailscale 연결·Funnel·감시 예약작업·서버 상태를 한눈에 확인해 '접속 불가'를 원격으로 점검하기 위함.
export const dynamic = 'force-dynamic';

const PROJ = 'C:\\production-scheduler';

function tailscaleCmd(): string {
  for (const p of ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']) {
    if (existsSync(p)) return `"${p}"`;
  }
  return 'tailscale';
}

async function run(cmd: string, timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await pexec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
    return stdout || '';
  } catch (e) {
    return `__ERR__ ${(e as Error)?.message ?? String(e)}`;
  }
}

// 따옴표 지옥을 피하려 PowerShell은 EncodedCommand(UTF-16LE base64)로 실행한다.
function ps(script: string): string {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
}

export async function GET(req: NextRequest) {
  // 공개 Funnel(ts.net)로는 노출하지 않는다 — 사내망/로컬에서만.
  const host = (req.headers.get('host') || '').toLowerCase();
  if (host.includes('.ts.net')) return NextResponse.json({ error: 'not available' }, { status: 404 });

  const ts = tailscaleCmd();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = { now: new Date().toISOString(), host, serverUp: true };

  // 1) 외부 접속 URL 파일
  try { out.tunnelUrl = (await readFile(`${PROJ}\\tunnel-url.txt`, 'utf8')).trim(); } catch { out.tunnelUrl = null; }

  // 2) Tailscale 상태(민감한 peer 목록은 제외하고 필요한 값만)
  const statusJson = await run(`${ts} status --json`);
  try {
    const s = JSON.parse(statusJson);
    out.tailscale = { backendState: s.BackendState, selfOnline: s?.Self?.Online, dnsName: s?.Self?.DNSName, tailscaleVersion: s?.Version };
  } catch {
    out.tailscale = { error: statusJson.startsWith('__ERR__') ? statusJson : 'parse failed', raw: statusJson.slice(0, 200) };
  }

  // 3) Funnel 설정 상태(텍스트)
  const funnel = await run(`${ts} funnel status`);
  out.funnelStatus = funnel.slice(0, 600);
  out.funnelOn = /https:\/\/[a-z0-9.-]+\.ts\.net/i.test(funnel) && !/no serve config|off/i.test(funnel);

  // 4) 감시 예약작업 상태(로케일 무관하게 PowerShell로 구조화 조회)
  const taskJson = await run(ps(
    "$ErrorActionPreference='SilentlyContinue';" +
    "$t=Get-ScheduledTask -TaskName 'ps-funnel-watchdog';" +
    "$i=Get-ScheduledTaskInfo -TaskName 'ps-funnel-watchdog';" +
    "if($t){[pscustomobject]@{exists=$true;state=[string]$t.State;lastRunTime=[string]$i.LastRunTime;lastTaskResult=$i.LastTaskResult;nextRunTime=[string]$i.NextRunTime;missedRuns=$i.NumberOfMissedRuns}|ConvertTo-Json -Compress}else{'{\"exists\":false}'}"
  ));
  try { out.watchdogTask = JSON.parse(taskJson.trim()); } catch { out.watchdogTask = { error: taskJson.slice(0, 200) }; }

  // 5) 감시 로그: 마지막 줄들 + '실제 끊김 이력'만 별도 추출
  //    ?lines=N 으로 tail 길이 조절(기본 12, 최대 500).
  const nParam = Number(new URL(req.url).searchParams.get('lines'));
  const tailN = Number.isFinite(nParam) && nParam > 0 ? Math.min(nParam, 500) : 12;
  try {
    const log = await readFile(`${PROJ}\\funnel-watchdog.log`, 'utf8');
    const all = log.trim().split(/\r?\n/);
    out.watchdogLogTail = all.slice(-tailN);
    // 앱 keepalive가 Tailscale 끊김을 감지해 재연결한 이력(신뢰 가능한 신호). 정상이면 'up' 라인이 없다.
    out.tailscaleDropEvents = all.filter((l) => l.includes('[app]') && l.includes('-> tailscale up')).slice(-50);
    out.appKeepaliveLines = all.filter((l) => l.includes('[app]')).slice(-50);
  } catch { out.watchdogLogTail = null; }

  return NextResponse.json(out);
}
