import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { order_id, machine_id, start_time } = await req.json();
  const db = await getDb();

  const orderResult = await db.execute({ sql: 'SELECT quantity_sheets FROM orders WHERE id = ?', args: [order_id] });
  const order = orderResult.rows[0] as unknown as { quantity_sheets: number } | undefined;

  const machineResult = await db.execute({
    sql: 'SELECT speed_sheets_per_hour, setup_time_minutes FROM machines WHERE id = ?',
    args: [machine_id],
  });
  const machine = machineResult.rows[0] as unknown as { speed_sheets_per_hour: number; setup_time_minutes: number } | undefined;

  let duration = 60;
  if (order && machine) {
    const printMinutes = (Number(order.quantity_sheets) / Number(machine.speed_sheets_per_hour)) * 60;
    duration = Math.ceil(printMinutes + Number(machine.setup_time_minutes));
  }

  const maxSeqResult = await db.execute({
    sql: 'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM schedule_entries WHERE machine_id = ?',
    args: [machine_id],
  });
  const maxSeq = Number((maxSeqResult.rows[0] as unknown as { max_seq: number }).max_seq);

  const today = new Date().toISOString().split('T')[0];

  await db.execute({
    sql: 'INSERT INTO schedule_entries (order_id, machine_id, sequence, duration_minutes, scheduled_date, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [order_id, machine_id, maxSeq + 1, duration, today, today + ' 08:00', today + ' 08:00'],
  });

  await db.execute({ sql: "UPDATE orders SET status = 'scheduled' WHERE id = ?", args: [order_id] });

  await recalcMachine(machine_id, today, start_time);

  return NextResponse.json({ success: true });
}
