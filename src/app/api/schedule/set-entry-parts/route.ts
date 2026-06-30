import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardEntry } from '@/lib/permits';
import { recalcMachine } from '@/lib/calc';
import { effectiveMinutes } from '@/lib/print';
import { sumDurations } from '@/lib/parts';

// 한 배정 행(엔트리)의 구성·파트별 소요시간을 직접 설정한다.
// 설비에서 작업을 '그 설비 것만' 수정할 때 사용(같은 주문이 다른 설비에도 배정돼 있어도 그 행만 반영).
// body: { entry_id, parts: [{ name, minutes }] }   minutes = 단면 기준 base 분.
// parts가 비면 그 행을 삭제한다.
export async function POST(req: NextRequest) {
  const { entry_id, parts } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();
  const row = (await db.execute({ sql: 'SELECT machine_id, print_mode FROM schedule_entries WHERE id = ?', args: [entry_id] }))
    .rows[0] as unknown as { machine_id: number; print_mode: string } | undefined;
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const list = Array.isArray(parts) ? parts : [];
  const durs: Record<string, number> = {};
  for (const p of list) {
    const n = String(p?.name ?? '').trim();
    if (n) durs[n] = Math.max(0, Math.round(Number(p?.minutes) || 0));
  }
  const names = Object.keys(durs);
  if (names.length === 0) {
    await db.execute({ sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [entry_id] });
  } else {
    const base = sumDurations(durs);
    await db.execute({
      sql: 'UPDATE schedule_entries SET component_part = ?, part_durations = ?, base_minutes = ?, duration_minutes = ? WHERE id = ?',
      args: [names.join(', '), JSON.stringify(durs), base, effectiveMinutes(base, row.print_mode), entry_id],
    });
  }
  await recalcMachine(Number(row.machine_id), new Date().toISOString().split('T')[0]);
  return NextResponse.json({ success: true });
}
