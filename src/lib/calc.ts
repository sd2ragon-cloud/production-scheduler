import { getDb } from './db';

interface Machine {
  id: number;
  name: string;
  work_start_hour: number;
  work_end_hour: number;
  works_saturday: number;
  works_sunday: number;
  schedule_start_time?: string;
}

interface AssignedEntry {
  id: number;
  duration_minutes: number;
}

function isWorkDay(date: Date, machine: Machine): boolean {
  const day = date.getDay();
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

// min(분) 이후로 가장 이른 '작업 가능' 시각을 반환. 휴게시간이면 그 끝으로 밀어낸다.
// 근무 종료(workEnd)를 넘으면 null. (하한은 호출부에서 curMin으로 정함 — 수동 시작시간을 그대로 존중)
function nextWorkingMinute(min: number, workEnd: number, breaks: Break[]): number | null {
  let m = min;
  for (let i = 0; i <= breaks.length; i++) {
    if (m >= workEnd) return null;
    const hit = breaks.find(([bs, be]) => m >= bs && m < be);
    if (!hit) return m;
    m = hit[1];
  }
  return m >= workEnd ? null : m;
}

// 작업 가능한 시각 m 이후 작업이 끊기는 다음 경계(근무 종료 또는 다음 휴게 시작).
function nextBreakBoundary(m: number, workEnd: number, breaks: Break[]): number {
  let boundary = workEnd;
  for (const [bs] of breaks) {
    if (bs > m && bs < boundary) boundary = bs;
  }
  return boundary;
}

// 자정 기준 분 → "YYYY-MM-DD HH:MM". totalMin이 하루(1440분)를 넘으면(예: 24:00)
// 날짜를 넘겨 다음날 00:00으로 정규화한다. (24시간 가동 기계의 자정 종료 표기 대응)
function formatDateTimeMin(date: Date, totalMin: number): string {
  const days = Math.floor(totalMin / (24 * 60));
  const minOfDay = totalMin - days * 24 * 60;
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return formatDateTime(d, Math.floor(minOfDay / 60), minOfDay % 60);
}

export async function recalcMachine(machineId: number, baseDate?: string, startTimeStr?: string) {
  const db = await getDb();

  const machineResult = await db.execute({ sql: 'SELECT * FROM machines WHERE id = ?', args: [machineId] });
  const machine = machineResult.rows[0] as unknown as Machine | undefined;
  if (!machine) return;

  const entriesResult = await db.execute({
    sql: 'SELECT se.id, se.duration_minutes FROM schedule_entries se WHERE se.machine_id = ? ORDER BY se.sequence ASC',
    args: [machineId],
  });
  const entries = entriesResult.rows as unknown as AssignedEntry[];

  const startDate = baseDate ? new Date(baseDate) : new Date();
  startDate.setHours(0, 0, 0, 0);

  const workStart = Number(machine.work_start_hour) * 60;
  const workEnd = Number(machine.work_end_hour) * 60;

  // 식사·휴게 시간을 DB에서 읽는다. 비어 있으면(=사용자가 전부 삭제) 제외 시간 없음, 테이블이 없으면 기본값으로 폴백.
  let breaks: Break[] = DEFAULT_BREAKS;
  try {
    const br = await db.execute('SELECT start_min, end_min FROM breaks ORDER BY start_min');
    breaks = br.rows.map((r) => [Number(r.start_min), Number(r.end_min)] as Break);
  } catch {
    // breaks 테이블 없음 → 기본값 유지
  }

  const currentDate = new Date(startDate);
  // 시작시각 우선순위: 명시 인자 > 기계에 저장된 schedule_start_time > 기본 08:00.
  // (배정해제·소요시간변경·순서변경 등 start_time 없이 호출돼도 저장된 시작시각을 유지)
  const startStr = startTimeStr || machine.schedule_start_time || '08:00';
  let curMin = workStart;
  {
    const [h, m] = String(startStr).split(':').map(Number);
    if (!isNaN(h)) curMin = h * 60 + (isNaN(m) ? 0 : m);
  }

  while (!isWorkDay(currentDate, machine)) {
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // 근무일/근무시간/휴게시간을 건너뛰어 다음 '작업 가능한' 시각으로 정렬한다.
  const advanceToWorking = () => {
    let pos = nextWorkingMinute(curMin, workEnd, breaks);
    while (pos === null) {
      currentDate.setDate(currentDate.getDate() + 1);
      while (!isWorkDay(currentDate, machine)) {
        currentDate.setDate(currentDate.getDate() + 1);
      }
      curMin = workStart;
      pos = nextWorkingMinute(curMin, workEnd, breaks);
    }
    curMin = pos;
  };

  const updates: { sql: string; args: (string | number)[] }[] = [];

  for (const entry of entries) {
    advanceToWorking();
    const startTime = formatDateTimeMin(currentDate, curMin);
    const scheduledDate = formatDate(currentDate);
    let remaining = Number(entry.duration_minutes);

    while (remaining > 0) {
      advanceToWorking();
      const boundary = nextBreakBoundary(curMin, workEnd, breaks);
      const available = boundary - curMin;
      if (remaining <= available) {
        curMin += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        curMin = boundary;
      }
    }

    const endTime = formatDateTimeMin(currentDate, curMin);
    updates.push({
      sql: 'UPDATE schedule_entries SET start_time = ?, end_time = ?, scheduled_date = ? WHERE id = ?',
      args: [startTime, endTime, scheduledDate, Number(entry.id)],
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
  const today = baseDate || new Date().toISOString().split('T')[0];
  const result = await db.execute('SELECT id FROM machines WHERE is_active = 1');
  for (const row of result.rows) {
    await recalcMachine(Number((row as unknown as { id: number }).id), today);
  }
}
