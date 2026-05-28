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

  let currentDate = new Date(startDate);
  let currentHour = Number(machine.work_start_hour);
  let currentMinute = 0;

  if (startTimeStr) {
    const [h, m] = startTimeStr.split(':').map(Number);
    if (!isNaN(h)) currentHour = h;
    if (!isNaN(m)) currentMinute = m;
  }

  while (!isWorkDay(currentDate, machine)) {
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const updates: { sql: string; args: (string | number)[] }[] = [];

  for (const entry of entries) {
    const startTime = formatDateTime(currentDate, currentHour, currentMinute);
    const scheduledDate = formatDate(currentDate);
    const totalMinutes = Number(entry.duration_minutes);

    if (totalMinutes > 0) {
      let remaining = totalMinutes;
      while (remaining > 0) {
        const minutesLeftInDay = (Number(machine.work_end_hour) - currentHour) * 60 - currentMinute;
        if (remaining <= minutesLeftInDay) {
          currentMinute += remaining;
          currentHour += Math.floor(currentMinute / 60);
          currentMinute = currentMinute % 60;
          remaining = 0;
        } else {
          remaining -= minutesLeftInDay;
          currentDate.setDate(currentDate.getDate() + 1);
          while (!isWorkDay(currentDate, machine)) {
            currentDate.setDate(currentDate.getDate() + 1);
          }
          currentHour = Number(machine.work_start_hour);
          currentMinute = 0;
        }
      }
    }

    const endTime = formatDateTime(currentDate, currentHour, currentMinute);
    updates.push({
      sql: 'UPDATE schedule_entries SET start_time = ?, end_time = ?, scheduled_date = ? WHERE id = ?',
      args: [startTime, endTime, scheduledDate, Number(entry.id)],
    });
  }

  if (updates.length > 0) {
    await db.batch(updates, 'write');
  }
}
