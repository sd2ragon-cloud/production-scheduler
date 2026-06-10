import { NextRequest, NextResponse } from 'next/server';
import { recalcMachine } from '@/lib/calc';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  const { machine_id, start_time } = await req.json();

  // 시작시각을 기계에 저장하여 이후 모든 재계산(배정해제·소요시간변경 등 포함)에서 유지되도록 한다.
  if (typeof start_time === 'string' && start_time) {
    const db = await getDb();
    await db.execute({ sql: 'UPDATE machines SET schedule_start_time = ? WHERE id = ?', args: [start_time, machine_id] });
  }

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(machine_id, today, start_time);

  return NextResponse.json({ success: true });
}
