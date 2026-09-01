import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { writeFile, appendFile } from 'fs/promises';

// 앱 내부 Funnel keepalive: 3분마다 Tailscale 연결/Funnel을 점검·재보장한다.
// 앱 프로세스는 Tailscale GUI와 같은 사용자 권한으로 돌아 tailscaled와 정상 통신되므로
// (관리자 권한 예약작업에서 상태를 못 읽던 문제를 우회) 외부 접속이 확실히 self-heal 된다.

const pexec = promisify(exec);
const PROJ = 'C:\\production-scheduler';
const LOG = `${PROJ}\\funnel-watchdog.log`;

function tailscaleCmd(): string | null {
  for (const p of ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']) {
    if (existsSync(p)) return `"${p}"`;
  }
  return null;
}

async function run(cmd: string, timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await pexec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
    return stdout || '';
  } catch {
    return '';
  }
}

async function log(msg: string) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [app] ${msg}\n`;
  try { await appendFile(LOG, line); } catch { /* ignore */ }
}

async function tick() {
  const ts = tailscaleCmd();
  if (!ts) return;
  let state = '';
  let dns = '';
  try {
    const j = JSON.parse(await run(`${ts} status --json`));
    state = j?.BackendState || '';
    dns = j?.Self?.DNSName || '';
  } catch { /* status 못 읽으면 up은 건너뛰고 funnel만 재보장 */ }

  // 연결이 끊긴 게 '확실할 때만' 재연결(상태를 못 읽으면 섣불리 up 하지 않음).
  if (state && state !== 'Running') {
    await log(`backend='${state}' -> tailscale up`);
    await run(`${ts} up`, 15000);
  }
  // Funnel은 항상 재보장(idempotent).
  await run(`${ts} funnel --bg 3000`);
  // 외부 URL 파일 갱신.
  if (dns) {
    try { await writeFile(`${PROJ}\\tunnel-url.txt`, 'https://' + dns.replace(/\.$/, '')); } catch { /* ignore */ }
  }
}

export function startFunnelKeepalive() {
  // 운영 노트북(윈도, C:\production-scheduler, Tailscale 설치)에서만. 중복 시작 방지.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__funnelKeepalive) return;
  if (process.platform !== 'win32') return;
  if (!existsSync(PROJ)) return;
  if (!tailscaleCmd()) return;
  g.__funnelKeepalive = true;
  log('funnel keepalive started (every 3 min)');
  tick().catch(() => {});
  setInterval(() => { tick().catch(() => {}); }, 3 * 60 * 1000);
}
