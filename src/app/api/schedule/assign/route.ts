import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { order_id, machine_id, start_time } = await req.json();
  const db = getDb();

  const order = db.prepare('SELECT quantity_sheets FROM orders WHERE id = ?').get(order_id) as {
    quantity_sheets: number;
  } | undefined;

  const machine = db.prepare(
    'SELECT speed_sheets_per_hour, setup_time_minutes FROM machines WHERE id = ?'
  ).get(machine_id) as {
    speed_sheets_per_hour: number;
    setup_time_minutes: number;
  } | undefined;

  let duration = 60;
  if (order && machine) {
    const printMinutes = (order.quantity_sheets / machine.speed_sheets_per_hour) * 60;
    duration = Math.ceil(printMinutes + machine.setup_time_minutes);
  }

  const maxSeq = db.prepare(
    'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM schedule_entries WHERE machine_id = ?'
  ).get(machine_id) as { max_seq: number };

  const today = new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO schedule_entries (order_id, machine_id, sequence, duration_minutes, scheduled_date, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(order_id, machine_id, maxSeq.max_seq + 1, duration, today, today + ' 08:00', today + ' 08:00');

  db.prepare("UPDATE orders SET status = 'scheduled' WHERE id = ?").run(order_id);

  recalcMachine(machine_id, today, start_time);

  return NextResponse.json({ success: true });
}
