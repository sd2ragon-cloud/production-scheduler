import { getDb } from './db';
import { todayLocal } from '@/lib/date';
import { SHIFTS, parseDayShifts } from './shifts';

interface Machine {
  id: number;
  name: string;
  work_start_hour: number;
  work_end_hour: number;
  works_saturday: number;
  works_sunday: number;
  off_days?: string; // 휴무 요일 JSON 배열 (0=일~6=토)
  day_hours?: string; // 요일별 근무시간 오버라이드 JSON (예: {"6":[8,18]})
  day_shifts?: string; // 요일별 근무체제 JSON (예: {"1":["정상(주)","정상(야)"]})
  schedule_start_time?: string;
}

interface AssignedEntry {
  id: number;
  duration_minutes: number;
}

// 휴무 요일 파싱: 0~6 범위의 유효한 값만. 7요일 전부 휴무(전체 휴무 설비)도 허용.
function parseOffDays(json: string | undefined | null): number[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? Array.from(new Set(a.map(Number).filter((n) => n >= 0 && n <= 6))) : [];
  } catch {
    return [];
  }
}

// 요일별 근무시간 오버라이드 파싱. { "1":[8,24], "6":[8,18] } (키=요일 0~6, 값=[시작시,종료시]).
function parseDayHours(json: string | undefined | null): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {};
  if (!json) return out;
  try {
    const o = JSON.parse(json);
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        const d = Number(k);
        const v = (o as Record<string, unknown>)[k];
        if (d >= 0 && d <= 6 && Array.isArray(v) && v.length === 2) {
          const s = Number(v[0]);
          const e = Number(v[1]);
          if (Number.isFinite(s) && Number.isFinite(e)) {
            out[d] = [Math.min(Math.max(s, 0), 24), Math.min(Math.max(e, 0), 24)];
          }
        }
      }
    }
  } catch {
    /* 잘못된 JSON → 오버라이드 없음 */
  }
  return out;
}

function isWorkDay(date: Date, machine: Machine): boolean {
  const day = date.getDay();
  // off_days가 있으면 그걸로 판정, 없으면(구버전 행) works_saturday/works_sunday로 폴백.
  if (machine.off_days != null && machine.off_days !== '') {
    return !parseOffDays(machine.off_days).includes(day);
  }
  if (day === 0) return machine.works_sunday === 1;
  if (day === 6) return machine.works_saturday === 1;
  return true;
}

function formatDateTime(date: Date, hour: number, minute: number): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 식사·휴게 시간(자정 기준 분 단위, [시작, 끝)). 이 시간대에는 작업하지 않으므로 예상완료시간에서 제외한다.
// 실제 값은 breaks 테이블에서 읽어오며(앱에서 추가/수정/삭제로 관리), 테이블이 없을 때만 아래 기본값으로 폴백한다.
// 기본값: 점심 12:00~13:00, 저녁 17:30~18:30, 야식 00:00~01:00 (각 1시간) — db.ts 시드값과 동일.
type Break = [number, number];
const DEFAULT_BREAKS: Break[] = [
  [12 * 60, 13 * 60],
  [17 * 60 + 30, 18 * 60 + 30],
  [0 * 60, 1 * 60],
];

// 자정 기준 분 → "YYYY-MM-DD HH:MM". totalMin이 하루(1440분)를 넘으면(예: 24:00)
// 날짜를 넘겨 다음날 00:00으로 정규화한다. (24시간 가동 기계의 자정 종료 표기 대응)
function formatDateTimeMin(date: Date, totalMin: number): string {
  const days = Math.floor(totalMin / (24 * 60));
  const minOfDay = totalMin - days * 24 * 60;
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return formatDateTime(d, Math.floor(minOfDay / 60), minOfDay % 60);
}

export async function recalcMachine(machineId: number, baseDate?: string, _startTimeStr?: string) {
  const db = await getDb();

  const machineResult = await db.execute({ sql: 'SELECT * FROM machines WHERE id = ?', args: [machineId] });
  const machine = machineResult.rows[0] as unknown as Machine | undefined;
  if (!machine) return;

  const entriesResult = await db.execute({
    sql: 'SELECT se.id, se.duration_minutes FROM schedule_entries se WHERE se.machine_id = ? ORDER BY se.sequence ASC',
    args: [machineId],
  });
  const entries = entriesResult.rows as unknown as AssignedEntry[];

  // baseDate('YYYY-MM-DD')는 로컬 날짜로 해석한다. new Date('2026-07-01')은 UTC 자정으로 파싱돼
  // 타임존에 따라 하루 어긋날 수 있으므로 'T00:00:00'을 붙여 로컬 자정으로 파싱한다.
  const startDate = baseDate ? new Date(baseDate + 'T00:00:00') : new Date();
  startDate.setHours(0, 0, 0, 0);

  // 해당 날짜(요일)의 근무 구간[분]을 구한다. 요일별 오버라이드(day_hours)가 있으면 그 값을,
  // 없으면 기본 work_start/work_end를 쓴다. 종료<=시작(예: 8~8)이면 24시간 가동(0~24시)으로 해석한다.
  const dayOverrides = parseDayHours(machine.day_hours);
  const hoursFor = (date: Date): { start: number; end: number } => {
    const ov = dayOverrides[date.getDay()];
    let start = (ov ? ov[0] : Number(machine.work_start_hour)) * 60;
    let end = (ov ? ov[1] : Number(machine.work_end_hour)) * 60;
    if (end <= start) {
      start = 0;
      end = 24 * 60;
    }
    return { start, end };
  };

  // 식사·휴게 시간을 DB에서 읽는다. 비어 있으면(=사용자가 전부 삭제) 제외 시간 없음, 테이블이 없으면 기본값으로 폴백.
  let breaks: Break[] = DEFAULT_BREAKS;
  try {
    const br = await db.execute('SELECT start_min, end_min FROM breaks ORDER BY start_min');
    breaks = br.rows.map((r) => [Number(r.start_min), Number(r.end_min)] as Break);
  } catch {
    // breaks 테이블 없음 → 기본값 유지
  }

  // 근무체제(교대) 사용 여부. 설정이 있으면 요일별 근무체제로, 없으면 구버전 시작/종료(또는 day_hours)로.
  const dayShifts = parseDayShifts(machine.day_shifts);
  const useShifts = Object.keys(dayShifts).length > 0;

  // 해당 날짜의 근무 가능 구간들 [시작분, 종료분] (종료가 1440 초과면 익일까지 — 야간 근무).
  const dayWindows = (date: Date): [number, number][] => {
    if (useShifts) {
      return (dayShifts[date.getDay()] || [])
        .map((n) => SHIFTS[n])
        .filter(Boolean)
        .map((s) => [s.start, s.end] as [number, number]);
    }
    if (!isWorkDay(date, machine)) return [];
    const { start, end } = hoursFor(date);
    return [[start, end]];
  };

  // 시작 시각: 설정 없이 무조건 해당 일 08:30(자정 기준 분)에 시작.
  const startMin = 8 * 60 + 30;

  // 총 소요시간에 맞춰 충분한 일수의 '근무 가능 구간'을 절대 타임라인(startDate 자정 기준 분)으로 만든다.
  const totalDur = entries.reduce((s, e) => s + (Number(e.duration_minutes) || 0), 0);
  const horizon = Math.min(500, Math.max(45, Math.ceil(totalDur / 240) + 21));
  const rawIv: [number, number][] = [];
  for (let d = 0; d < horizon; d++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + d);
    for (const [s, e] of dayWindows(date)) rawIv.push([d * 1440 + s, d * 1440 + e]);
  }
  rawIv.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of rawIv) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  // 식사·휴게시간 차감(매일 반복; 야간이 자정을 넘기므로 끝쪽 며칠 더 포함).
  let work: [number, number][] = merged;
  for (let d = 0; d <= horizon + 1; d++) {
    for (const [bs, be] of breaks) {
      const a = d * 1440 + bs;
      const b = d * 1440 + be;
      const next: [number, number][] = [];
      for (const [ws, we] of work) {
        if (b <= ws || a >= we) { next.push([ws, we]); continue; }
        if (a > ws) next.push([ws, a]);
        if (b < we) next.push([b, we]);
      }
      work = next;
    }
  }
  work = work.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);

  // 비가동시간(설비고장·교육훈련 등) 차감: 'YYYY-MM-DD HH:MM'를 절대분으로 바꿔 work에서 제거.
  let downtimes: { start_time: string; end_time: string }[] = [];
  try {
    const dt = await db.execute({ sql: 'SELECT start_time, end_time FROM downtimes WHERE machine_id = ?', args: [machineId] });
    downtimes = dt.rows as unknown as { start_time: string; end_time: string }[];
  } catch {
    // downtimes 테이블 없음 → 무시
  }
  const baseMs = startDate.getTime();
  for (const dn of downtimes) {
    const a = Math.round((new Date(String(dn.start_time).replace(' ', 'T')).getTime() - baseMs) / 60000);
    const b = Math.round((new Date(String(dn.end_time).replace(' ', 'T')).getTime() - baseMs) / 60000);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    const next: [number, number][] = [];
    for (const [ws, we] of work) {
      if (b <= ws || a >= we) { next.push([ws, we]); continue; }
      if (a > ws) next.push([ws, a]);
      if (b < we) next.push([b, we]);
    }
    work = next;
  }
  work = work.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);

  // 근무 가능 시간이 전혀 없으면(전체 휴무 등) 모든 작업의 시작/완료를 비운다.
  if (work.length === 0) {
    const offUpdates = entries.map((e) => ({
      sql: 'UPDATE schedule_entries SET start_time = ?, end_time = ?, scheduled_date = ? WHERE id = ?',
      args: ['', '', formatDate(startDate), Number(e.id)] as (string | number)[],
    }));
    if (offUpdates.length > 0) await db.batch(offUpdates, 'write');
    return;
  }

  // 작업을 순서대로 근무 가능 구간에 채워 시작/완료를 정한다.
  let cursor = startMin;
  let ivIdx = 0;
  const updates: { sql: string; args: (string | number)[] }[] = [];
  for (const entry of entries) {
    while (ivIdx < work.length && work[ivIdx][1] <= cursor) ivIdx++;
    if (ivIdx >= work.length) cursor = work[work.length - 1][1];
    const startAbs = ivIdx < work.length ? Math.max(cursor, work[ivIdx][0]) : cursor;
    let remaining = Number(entry.duration_minutes) || 0;
    let pos = startAbs;
    let i = ivIdx;
    while (remaining > 0 && i < work.length) {
      const ws = Math.max(pos, work[i][0]);
      const avail = work[i][1] - ws;
      if (remaining <= avail) { pos = ws + remaining; remaining = 0; }
      else { remaining -= avail; pos = work[i][1]; i++; }
    }
    const endAbs = pos;
    cursor = endAbs;
    ivIdx = Math.min(i, work.length - 1);
    const eDate = new Date(startDate);
    eDate.setDate(startDate.getDate() + Math.floor(startAbs / 1440));
    updates.push({
      sql: 'UPDATE schedule_entries SET start_time = ?, end_time = ?, scheduled_date = ? WHERE id = ?',
      args: [formatDateTimeMin(startDate, startAbs), formatDateTimeMin(startDate, endAbs), formatDate(eDate), Number(entry.id)],
    });
  }

  if (updates.length > 0) {
    await db.batch(updates, 'write');
  }
}

// 모든 활성 설비의 일정을 다시 계산한다. 식사·휴게 시간이 바뀌면 모든 설비의 예상완료시간이
// 달라지므로 전 설비를 재계산해야 한다. 각 설비는 저장된 schedule_start_time을 그대로 유지한다.
export async function recalcAllMachines(baseDate?: string) {
  const db = await getDb();
  const today = baseDate || todayLocal();
  const result = await db.execute('SELECT id FROM machines WHERE is_active = 1');
  for (const row of result.rows) {
    await recalcMachine(Number((row as unknown as { id: number }).id), today);
  }
}
