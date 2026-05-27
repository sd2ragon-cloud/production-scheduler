import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { machine_id, entry_ids } = await req.json() as { machine_id: number; entry_ids: number[] };
  const db = getDb();

  const updateStmt = db.prepare('UPDATE schedule_entries SET sequence = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    entry_ids.forEach((id: number, index: number) => {
      updateStmt.run(index + 1, id);
    });
  });
  transaction();

  const today = new Date().toISOString().split('T')[0];
  recalcMachine(machine_id, today);

  return NextResponse.json({ success: true });
}
