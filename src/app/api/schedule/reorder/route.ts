import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { machine_id, entry_ids } = await req.json() as { machine_id: number; entry_ids: number[] };
  const db = await getDb();

  const stmts = entry_ids.map((id: number, index: number) => ({
    sql: 'UPDATE schedule_entries SET sequence = ? WHERE id = ?',
    args: [index + 1, id],
  }));

  await db.batch(stmts, 'write');

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(machine_id, today);

  return NextResponse.json({ success: true });
}
