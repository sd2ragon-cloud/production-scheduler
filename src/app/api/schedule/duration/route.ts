import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { entry_id, duration_minutes } = await req.json();
  const db = await getDb();

  const entryResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const entry = entryResult.rows[0] as unknown as { id: number; machine_id: number } | undefined;

  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  await db.execute({ sql: 'UPDATE schedule_entries SET duration_minutes = ? WHERE id = ?', args: [duration_minutes, entry_id] });

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(Number(entry.machine_id), today);

  return NextResponse.json({ success: true });
}
