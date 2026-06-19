import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parsePartDurations, sumDurations } from '@/lib/parts';
import { effectiveMinutes } from '@/lib/print';
import { guardEntry } from '@/lib/permits';

export async function POST(req: NextRequest) {
  const { entry_id, duration_minutes } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const entryResult = await db.execute({ sql: 'SELECT id, machine_id, print_mode, part_durations FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const entry = entryResult.rows[0] as unknown as { id: number; machine_id: number; print_mode: string; part_durations: string } | undefined;

  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // 입력값은 실제(인쇄 모드 적용 후) 소요시간. 단면 기준 base로 환산한다.
  // (양면이면 실제시간의 2배가 단면 기준, 단면이면 그대로)
  const eff = Number(duration_minutes) || 0;
  const newBase = entry.print_mode === 'single' ? eff : eff * 2;

  // 파트 작업이면 각 파트 시간을 비율대로 배분해 합계가 newBase가 되게 한다.
  const durs = parsePartDurations(entry.part_durations);
  const partNames = Object.keys(durs);
  let partDurationsJson = entry.part_durations;
  if (partNames.length > 0) {
    const oldBase = sumDurations(durs);
    if (oldBase > 0) {
      const factor = newBase / oldBase;
      for (const p of partNames) durs[p] = Math.round((Number(durs[p]) || 0) * factor);
    } else {
      const each = Math.round(newBase / partNames.length);
      for (const p of partNames) durs[p] = each;
    }
    partDurationsJson = JSON.stringify(durs);
  }
  // 배분 과정의 반올림 오차를 흡수하기 위해 실제 합계로 base를 다시 잡는다.
  const base = partNames.length > 0 ? sumDurations(durs) : newBase;

  await db.execute({
    sql: 'UPDATE schedule_entries SET part_durations = ?, base_minutes = ?, duration_minutes = ? WHERE id = ?',
    args: [partDurationsJson, base, effectiveMinutes(base, entry.print_mode), entry_id],
  });

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(Number(entry.machine_id), today);

  return NextResponse.json({ success: true });
}
