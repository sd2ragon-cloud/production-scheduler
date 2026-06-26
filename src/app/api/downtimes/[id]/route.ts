import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardMachine } from '@/lib/permits';
import { recalcMachine } from '@/lib/calc';

// 비가동시간 삭제. 해당 설비 편집 권한 확인 후 삭제하고 재계산.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const row = (await db.execute({ sql: 'SELECT machine_id FROM downtimes WHERE id = ?', args: [id] })).rows[0] as unknown as { machine_id: number } | undefined;
  if (!row) return NextResponse.json({ success: true });
  const machineId = Number(row.machine_id);
  const deny = await guardMachine(req, machineId);
  if (deny) return deny;
  await db.execute({ sql: 'DELETE FROM downtimes WHERE id = ?', args: [id] });
  await recalcMachine(machineId, new Date().toISOString().split('T')[0]);
  return NextResponse.json({ success: true });
}
