import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, sumDurations, partTotals } from '@/lib/parts';
import { effectiveMinutes } from '@/lib/print';
import { guardEntry } from '@/lib/permits';

// 설비에 배정된 특정 파트를 떼어 배정 대기로 되돌린다(그 엔트리에서의 배정 취소).
export async function POST(req: NextRequest) {
  const { entry_id, part } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const partStr = typeof part === 'string' ? part.trim() : '';
  const db = await getDb();

  if (!partStr) {
    return NextResponse.json({ error: 'no part' }, { status: 400 });
  }

  const srcResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcResult.rows[0] as unknown as
    | { id: number; order_id: number; machine_id: number; sequence: number; component_part: string; part_durations: string; print_mode: string }
    | undefined;
  if (!src) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const orderId = Number(src.order_id);
  const srcMachine = Number(src.machine_id);
  const srcParts = parseParts(String(src.component_part));
  if (!srcParts.includes(partStr)) {
    return NextResponse.json({ error: 'part not in entry' }, { status: 400 });
  }

  const remaining = srcParts.filter((p) => p !== partStr);
  const durs = parsePartDurations(src.part_durations);

  if (remaining.length === 0) {
    await db.execute({ sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [Number(src.id)] });
    await db.execute({
      sql: 'UPDATE schedule_entries SET sequence = sequence - 1 WHERE machine_id = ? AND sequence > ?',
      args: [srcMachine, Number(src.sequence)],
    });
  } else {
    delete durs[partStr];
    await db.execute({
      sql: 'UPDATE schedule_entries SET component_part = ?, part_durations = ?, duration_minutes = ? WHERE id = ?',
      args: [remaining.join(', '), JSON.stringify(durs), effectiveMinutes(sumDurations(durs), src.print_mode), Number(src.id)],
    });
  }

  // 주문 상태 재계산 (시간 기준 완료 판정)
  const orderResult = await db.execute({ sql: 'SELECT component, duration_minutes, part_durations FROM orders WHERE id = ?', args: [orderId] });
  const order = orderResult.rows[0] as unknown as { component: string; duration_minutes: number; part_durations: string } | undefined;
  const totals = partTotals(order?.component ?? '', order?.part_durations, Number(order?.duration_minutes) || 0);
  const partNames = Object.keys(totals);
  const allEntries = await db.execute({ sql: 'SELECT component_part, part_durations FROM schedule_entries WHERE order_id = ?', args: [orderId] });
  let allAssigned: boolean;
  if (partNames.length === 0) {
    allAssigned = allEntries.rows.length >= 1;
  } else {
    const allocated: Record<string, number> = {};
    const present = new Set<string>();
    for (const r of allEntries.rows as unknown as { component_part: string; part_durations: string }[]) {
      const d = parsePartDurations(r.part_durations);
      for (const [p, m] of Object.entries(d)) allocated[p] = (allocated[p] || 0) + (Number(m) || 0);
      parseParts(String(r.component_part)).forEach((p) => present.add(p));
    }
    allAssigned = partNames.every((p) => {
      const t = totals[p];
      return t > 0 ? (allocated[p] || 0) >= t : present.has(p);
    });
  }
  await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [allAssigned ? 'scheduled' : 'pending', orderId] });

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(srcMachine, today);

  return NextResponse.json({ success: true });
}
