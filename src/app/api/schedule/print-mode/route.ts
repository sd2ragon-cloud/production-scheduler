import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parsePartDurations, sumDurations } from '@/lib/parts';
import { effectiveMinutes } from '@/lib/print';
import { guardEntry } from '@/lib/permits';

// 한 배정 행의 인쇄 모드(양면/단면)를 전환하고 소요시간을 재계산한다.
export async function POST(req: NextRequest) {
  const { entry_id, mode } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const newMode = mode === 'single' ? 'single' : 'double';
  const db = await getDb();

  const result = await db.execute({
    sql: 'SELECT machine_id, part_durations, base_minutes, duration_minutes FROM schedule_entries WHERE id = ?',
    args: [entry_id],
  });
  const entry = result.rows[0] as unknown as { machine_id: number; part_durations: string; base_minutes: number; duration_minutes: number } | undefined;
  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // 파트 작업은 part_durations 합계가 base, 통째 작업은 base_minutes(없으면 현재 소요시간)가 base.
  const partBase = sumDurations(parsePartDurations(entry.part_durations));
  const base = partBase > 0 ? partBase : (Number(entry.base_minutes) || Number(entry.duration_minutes) || 0);
  await db.execute({
    sql: 'UPDATE schedule_entries SET print_mode = ?, base_minutes = ?, duration_minutes = ? WHERE id = ?',
    args: [newMode, base, effectiveMinutes(base, newMode), entry_id],
  });

  const today = todayLocal();
  await recalcMachine(Number(entry.machine_id), today);

  return NextResponse.json({ success: true });
}
