import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { entry_id } = await req.json();
  const db = getDb();

  const entry = db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id) as {
    id: number; order_id: number; machine_id: number; sequence: number;
  } | undefined;

  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  db.prepare('DELETE FROM schedule_entries WHERE id = ?').run(entry_id);
  db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(entry.order_id);

  db.prepare(`
    UPDATE schedule_entries
    SET sequence = sequence - 1
    WHERE machine_id = ? AND sequence > ?
  `).run(entry.machine_id, entry.sequence);

  const today = new Date().toISOString().split('T')[0];
  recalcMachine(entry.machine_id, today);

  return NextResponse.json({ success: true });
}
