import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { guardMachine } from '@/lib/permits';
import { snapshotPlates, flagPlateChanges } from '@/lib/plates';

export async function POST(req: NextRequest) {
  const { machine_id, entry_ids } = await req.json() as { machine_id: number; entry_ids: number[] };
  const deny = await guardMachine(req, machine_id);
  if (deny) return deny;
  const db = await getDb();
  const before = await snapshotPlates([machine_id]);

  const stmts = entry_ids.map((id: number, index: number) => ({
    sql: 'UPDATE schedule_entries SET sequence = ? WHERE id = ?',
    args: [index + 1, id],
  }));

  await db.batch(stmts, 'write');

  const today = todayLocal();
  await recalcMachine(machine_id, today);
  const plate_warnings = await flagPlateChanges(before, [machine_id]);

  return NextResponse.json({ success: true, plate_warnings });
}
