import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, parsePartProcesses, parsePartBuckets, sumDurations, partTotals } from '@/lib/parts';
import { effectiveMinutes } from '@/lib/print';
import { guardEntry } from '@/lib/permits';

// 완료된 구성(칩) 영구 삭제: 해당 엔트리에서 파트를 빼고, 주문 사양에서도 그 구성을 제거한다.
// (배정 대기로 복귀하지 않음 = 완료 처리)
export async function POST(req: NextRequest) {
  const { entry_id, part } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const partStr = typeof part === 'string' ? part.trim() : '';
  if (!partStr) return NextResponse.json({ error: 'no part' }, { status: 400 });
  const db = await getDb();

  const srcResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcResult.rows[0] as unknown as
    | { id: number; order_id: number; machine_id: number; sequence: number; component_part: string; part_durations: string; print_mode: string }
    | undefined;
  if (!src) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const orderId = Number(src.order_id);
  const srcMachine = Number(src.machine_id);

  // 1) 엔트리에서 파트 제거 (마지막 파트면 행 삭제 + 순서 보정)
  const srcParts = parseParts(String(src.component_part));
  if (srcParts.includes(partStr)) {
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
  }

  // 2) 주문 사양에서 그 구성을 제거 → 남은 구성으로 다시 잡히지 않음(완료)
  const ordRes = await db.execute({
    sql: 'SELECT component, part_durations, part_processes, part_quantities, part_buckets FROM orders WHERE id = ?',
    args: [orderId],
  });
  const ord = ordRes.rows[0] as unknown as
    | { component: string; part_durations: string; part_processes: string; part_quantities: string; part_buckets: string }
    | undefined;
  if (ord) {
    const comp = parseParts(String(ord.component)).filter((p) => p !== partStr).join(', ');
    const pd = parsePartDurations(ord.part_durations); delete pd[partStr];
    const pp = parsePartProcesses(ord.part_processes); delete pp[partStr];
    const pq = parsePartDurations(ord.part_quantities); delete pq[partStr];
    const pb = parsePartBuckets(ord.part_buckets); delete pb[partStr];
    await db.execute({
      sql: 'UPDATE orders SET component = ?, part_durations = ?, part_processes = ?, part_quantities = ?, part_buckets = ? WHERE id = ?',
      args: [comp, JSON.stringify(pd), JSON.stringify(pp), JSON.stringify(pq), JSON.stringify(pb), orderId],
    });
  }

  // 3) 주문 상태 재계산 (갱신된 구성 기준)
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
