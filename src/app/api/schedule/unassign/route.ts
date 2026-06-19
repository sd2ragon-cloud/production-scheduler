import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { guardEntry } from '@/lib/permits';

export async function POST(req: NextRequest) {
  const { entry_id } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const entryResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const entry = entryResult.rows[0] as unknown as { id: number; order_id: number; machine_id: number; sequence: number } | undefined;

  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  await db.batch([
    { sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [entry_id] },
    { sql: "UPDATE orders SET status = 'pending' WHERE id = ?", args: [Number(entry.order_id)] },
    { sql: 'UPDATE schedule_entries SET sequence = sequence - 1 WHERE machine_id = ? AND sequence > ?', args: [Number(entry.machine_id), Number(entry.sequence)] },
  ], 'write');

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(Number(entry.machine_id), today);

  return NextResponse.json({ success: true });
}
