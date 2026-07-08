import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, sumDurations } from '@/lib/parts';
import { effectiveMinutes } from '@/lib/print';
import { guardEntry } from '@/lib/permits';

export async function POST(req: NextRequest) {
  const { entry_id, duration_minutes } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const entryResult = await db.execute({ sql: 'SELECT id, order_id, machine_id, print_mode, part_durations FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const entry = entryResult.rows[0] as unknown as { id: number; order_id: number; machine_id: number; print_mode: string; part_durations: string } | undefined;

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

  // 주문 파트 총량을 실제 배정 합계와 동기화한다.
  // 설비에서 소요시간을 조정하면 그 파트의 엔트리 배분이 바뀌는데, 주문의 파트 총량은 그대로여서
  // (배정합 < 주문총량) '남은 구성'으로 오인되어 배정 대기에 유령 파트가 생기던 문제를 막는다.
  // 엔트리에 실제로 존재하는(배정된) 파트만 합계로 맞추고, 미배정(대기) 파트 총량은 건드리지 않는다.
  const orderId = Number(entry.order_id);
  const allEntries = await db.execute({ sql: 'SELECT component_part, part_durations FROM schedule_entries WHERE order_id = ?', args: [orderId] });
  const allocated: Record<string, number> = {};
  const present = new Set<string>();
  for (const r of allEntries.rows as unknown as { component_part: string; part_durations: string }[]) {
    parseParts(r.component_part).forEach((p) => present.add(p));
    for (const [p, m] of Object.entries(parsePartDurations(r.part_durations))) allocated[p] = (allocated[p] || 0) + (Number(m) || 0);
  }
  const ordRes = await db.execute({ sql: 'SELECT part_durations FROM orders WHERE id = ?', args: [orderId] });
  const ord = ordRes.rows[0] as unknown as { part_durations: string } | undefined;
  if (ord) {
    const opd = parsePartDurations(ord.part_durations);
    const partNames = Object.keys(opd);
    if (partNames.length > 0) {
      for (const p of partNames) {
        if (present.has(p)) opd[p] = allocated[p] || 0; // 배정된 파트: 실제 배정 합계로 맞춤
      }
      const allAssigned = partNames.every((p) => {
        const t = Number(opd[p]) || 0;
        return t > 0 ? (allocated[p] || 0) >= t : present.has(p);
      });
      await db.execute({
        sql: 'UPDATE orders SET part_durations = ?, duration_minutes = ?, status = ? WHERE id = ?',
        args: [JSON.stringify(opd), sumDurations(opd), allAssigned ? 'scheduled' : 'pending', orderId],
      });
    }
  }

  const today = todayLocal();
  await recalcMachine(Number(entry.machine_id), today);

  return NextResponse.json({ success: true });
}
