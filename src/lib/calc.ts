import { getDb } from './db';

interface Machine {
  id: number;
  name: string;
  work_start_hour: number;
  work_end_hour: number;
  works_saturday: number;
  works_sunday: number;
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
// 점심 12:00~13:00, 저녁 17:30~18:30, 야식 00:00~01:00 (각 1시간)
const BREAKS: [number, number][] = [
  [12 * 60, 13 * 60],
  [17 * 60 + 30, 18 * 60 + 30],
  [0 * 60, 1 * 60],
];

// min(분) 이후로 가장 이른 '작업 가능' 시각을 반환. 휴게시간이면 그 끝으로 밀어낸다.
// 근무 종료(workEnd)를 넘으면 null. (하한은 호출부에서 curMin으로 정함 — 수동 시작시간을 그대로 존중)
function nextWorkingMinute(min: number, workEnd: number): number | null {
  let m = min;
  for (let i = 0; i <= BREAKS.length; i++) {
    if (m >= workEnd) return null;
    const hit = BREAKS.find(([bs, be]) => m >= bs && m < be);
    if (!hit) return m;
    m = hit[1];
  }
  return m >= workEnd ? null : m;
}

// 작업 가능한 시각 m 이후 작업이 끊기는 다음 경계(근무 종료 또는 다음 휴게 시작).
function nextBreakBoundary(m: number, workEnd: number): number {
  let boundary = workEnd;
  for (const [bs] of BREAKS) {
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

  const currentDate = new Date(startDate);
  let curMin = workStart;

  if (startTimeStr) {
    const [h, m] = startTimeStr.split(':').map(Number);
    if (!isNaN(h)) curMin = h * 60 + (isNaN(m) ? 0 : m);
  }

  while (!isWorkDay(currentDate, machine)) {
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // 근무일/근무시간/휴게시간을 건너뛰어 다음 '작업 가능한' 시각으로 정렬한다.
  const advanceToWorking = () => {
    let pos = nextWorkingMinute(curMin, workEnd);
    while (pos === null) {
      currentDate.setDate(currentDate.getDate() + 1);
      while (!isWorkDay(currentDate, machine)) {
        currentDate.setDate(currentDate.getDate() + 1);
      }
      curMin = workStart;
      pos = nextWorkingMinute(curMin, workEnd);
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
      const boundary = nextBreakBoundary(curMin, workEnd);
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
