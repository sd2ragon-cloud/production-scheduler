import { getDb } from './db';

interface Machine {
  id: number;
  name: string;
  speed_sheets_per_hour: number;
  setup_time_minutes: number;
  capabilities: string;
  work_start_hour: number;
  work_end_hour: number;
  works_saturday: number;
  works_sunday: number;
}

interface Order {
  id: number;
  order_code: string;
  product_name: string;
  component: string;
  quantity_sheets: number;
  deadline: string;
  special_process: string;
  priority: number;
  notes: string;
}

interface ScheduleEntry {
  order_id: number;
  machine_id: number;
  sequence: number;
  scheduled_date: string;
  start_time: string;
  end_time: string;
}

function parseCapabilities(capStr: string): string[] {
  try {
    return JSON.parse(capStr);
  } catch {
    return [];
  }
}

function canMachineHandle(machine: Machine, order: Order): boolean {
  const caps = parseCapabilities(machine.capabilities);
  const process = order.special_process;

  if (process === '일반' || process === '') {
    return caps.includes('일반') || caps.includes('UV') || caps.includes('양면');
  }
  if (process === '항바니쉬') {
    return caps.includes('항바니쉬');
  }
  if (process === 'UV') {
    return caps.includes('UV');
  }
  if (process === 'IR코팅') {
    return caps.includes('IR코팅');
  }
  if (process === '양면') {
    return caps.includes('양면');
  }
  if (process === '패키지') {
    return caps.includes('패키지') || caps.includes('일반');
  }

  return caps.includes('일반');
}

function calcProcessingMinutes(machine: Machine, order: Order): number {
  const sheets = order.quantity_sheets;
  const hoursNeeded = sheets / machine.speed_sheets_per_hour;
  return Math.ceil(hoursNeeded * 60) + machine.setup_time_minutes;
}

function isWorkDay(date: Date, machine: Machine): boolean {
  const day = date.getDay();
  if (day === 0) return machine.works_sunday === 1;
  if (day === 6) return machine.works_saturday === 1;
  return true;
}

function addMinutesToWorkTime(
  startDate: Date,
  startHour: number,
  startMinute: number,
  minutes: number,
  machine: Machine
): { date: Date; hour: number; minute: number } {
  let remaining = minutes;
  let currentDate = new Date(startDate);
  let currentHour = startHour;
  let currentMinute = startMinute;

  while (remaining > 0) {
    const minutesLeftInDay = (machine.work_end_hour - currentHour) * 60 - currentMinute;

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
      currentHour = machine.work_start_hour;
      currentMinute = 0;
    }
  }

  return { date: currentDate, hour: currentHour, minute: currentMinute };
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function generateSchedule(targetDate?: string): {
  entries: ScheduleEntry[];
  warnings: string[];
} {
  const db = getDb();
  const warnings: string[] = [];

  const machines = db.prepare(
    'SELECT * FROM machines WHERE is_active = 1 ORDER BY id'
  ).all() as Machine[];

  const orders = db.prepare(
    "SELECT * FROM orders WHERE status = 'pending' ORDER BY priority DESC, deadline ASC, quantity_sheets DESC"
  ).all() as Order[];

  if (machines.length === 0) {
    return { entries: [], warnings: ['등록된 기계가 없습니다.'] };
  }
  if (orders.length === 0) {
    return { entries: [], warnings: ['배정할 주문이 없습니다.'] };
  }

  const baseDate = targetDate ? new Date(targetDate) : new Date();
  baseDate.setHours(0, 0, 0, 0);

  const machineEndTimes: Map<number, { date: Date; hour: number; minute: number }> = new Map();
  const machineSequences: Map<number, number> = new Map();

  for (const m of machines) {
    machineEndTimes.set(m.id, {
      date: new Date(baseDate),
      hour: m.work_start_hour,
      minute: 0,
    });
    machineSequences.set(m.id, 0);
  }

  const entries: ScheduleEntry[] = [];

  for (const order of orders) {
    const capableMachines = machines.filter((m) => canMachineHandle(m, order));

    if (capableMachines.length === 0) {
      warnings.push(
        `[${order.product_name} ${order.component}] 처리 가능한 기계가 없습니다. (공정: ${order.special_process})`
      );
      continue;
    }

    let bestMachine: Machine | null = null;
    let bestEndTime: { date: Date; hour: number; minute: number } | null = null;

    for (const m of capableMachines) {
      const currentEnd = machineEndTimes.get(m.id)!;
      const processingMinutes = calcProcessingMinutes(m, order);
      const endTime = addMinutesToWorkTime(
        currentEnd.date,
        currentEnd.hour,
        currentEnd.minute,
        processingMinutes,
        m
      );

      if (
        !bestEndTime ||
        endTime.date < bestEndTime.date ||
        (endTime.date.getTime() === bestEndTime.date.getTime() &&
          endTime.hour * 60 + endTime.minute < bestEndTime.hour * 60 + bestEndTime.minute)
      ) {
        bestMachine = m;
        bestEndTime = endTime;
      }
    }

    if (bestMachine && bestEndTime) {
      const currentStart = machineEndTimes.get(bestMachine.id)!;
      const seq = (machineSequences.get(bestMachine.id) || 0) + 1;
      machineSequences.set(bestMachine.id, seq);

      const entry: ScheduleEntry = {
        order_id: order.id,
        machine_id: bestMachine.id,
        sequence: seq,
        scheduled_date: formatDate(currentStart.date),
        start_time: `${formatDate(currentStart.date)} ${formatTime(currentStart.hour, currentStart.minute)}`,
        end_time: `${formatDate(bestEndTime.date)} ${formatTime(bestEndTime.hour, bestEndTime.minute)}`,
      };
      entries.push(entry);

      machineEndTimes.set(bestMachine.id, {
        date: new Date(bestEndTime.date),
        hour: bestEndTime.hour,
        minute: bestEndTime.minute,
      });

      const deadlineDate = new Date(order.deadline);
      if (bestEndTime.date > deadlineDate) {
        warnings.push(
          `⚠ [${order.product_name} ${order.component}] 납기(${order.deadline}) 초과! 예상완료: ${formatDate(bestEndTime.date)} ${formatTime(bestEndTime.hour, bestEndTime.minute)} → ${bestMachine.name}`
        );
      }
    }
  }

  return { entries, warnings };
}

export function saveSchedule(entries: ScheduleEntry[]) {
  const db = getDb();

  const deleteStmt = db.prepare('DELETE FROM schedule_entries');
  const insertStmt = db.prepare(`
    INSERT INTO schedule_entries (order_id, machine_id, sequence, scheduled_date, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateOrderStmt = db.prepare(
    "UPDATE orders SET status = 'scheduled' WHERE id = ?"
  );

  const transaction = db.transaction(() => {
    deleteStmt.run();
    for (const e of entries) {
      insertStmt.run(e.order_id, e.machine_id, e.sequence, e.scheduled_date, e.start_time, e.end_time);
      updateOrderStmt.run(e.order_id);
    }
  });

  transaction();
}
