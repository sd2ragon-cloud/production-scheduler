import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { entry_id, duration_minutes } = await req.json();
  const db = getDb();

  const entry = db.prepare('SELECT * FROM schedule_entries WHERE id = ?').get(entry_id) as {
    id: number; machine_id: number;
  } | undefined;

  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  db.prepare('UPDATE schedule_entries SET duration_minutes = ? WHERE id = ?')
    .run(duration_minutes, entry_id);

  const today = new Date().toISOString().split('T')[0];
  recalcMachine(entry.machine_id, today);

  return NextResponse.json({ success: true });
}
