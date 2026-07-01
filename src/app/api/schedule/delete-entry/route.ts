import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, parsePartProcesses, parsePartBuckets } from '@/lib/parts';
import { guardEntry } from '@/lib/permits';

// 설비 배정 항목(엔트리) 하나만 삭제한다. 그 설비의 배정만 없애고, 그 항목이 담당하던 구성은
// 다른 엔트리(다른 설비)에 없으면 주문 사양에서도 제거(배정 대기로 복귀하지 않음).
// 통짜(무구성) 주문은 그 항목 소요시간만큼 줄이고, 남은 엔트리가 없으면 주문 자체를 삭제한다.
export async function POST(req: NextRequest) {
  const { entry_id } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const src = (await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] }))
    .rows[0] as unknown as
    | { id: number; order_id: number; machine_id: number; sequence: number; component_part: string; base_minutes: number }
    | undefined;
  if (!src) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const orderId = Number(src.order_id);
  const machineId = Number(src.machine_id);
  const entryParts = parseParts(String(src.component_part));

  // 1) 이 엔트리 삭제 + 같은 설비 순서 보정
  await db.execute({ sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [Number(src.id)] });
  await db.execute({
    sql: 'UPDATE schedule_entries SET sequence = sequence - 1 WHERE machine_id = ? AND sequence > ?',
    args: [machineId, Number(src.sequence)],
  });

  // 남은(다른) 엔트리들
  const others = (await db.execute({ sql: 'SELECT component_part FROM schedule_entries WHERE order_id = ?', args: [orderId] }))
    .rows as unknown as { component_part: string }[];
  const partsElsewhere = new Set<string>();
  for (const o of others) parseParts(String(o.component_part)).forEach((p) => partsElsewhere.add(p));

  const ord = (await db.execute({
    sql: 'SELECT component, part_durations, part_processes, part_quantities, part_buckets, duration_minutes FROM orders WHERE id = ?',
    args: [orderId],
  })).rows[0] as unknown as
    | { component: string; part_durations: string; part_processes: string; part_quantities: string; part_buckets: string; duration_minutes: number }
    | undefined;

  if (ord) {
    const orderParts = parseParts(String(ord.component));
    if (orderParts.length > 0) {
      // 다중구성: 이 엔트리 구성 중 다른 엔트리에 없는 것만 주문에서 제거.
      const removeParts = entryParts.filter((p) => !partsElsewhere.has(p));
      if (removeParts.length > 0) {
        const keptParts = orderParts.filter((p) => !removeParts.includes(p));
        const pd = parsePartDurations(ord.part_durations);
        const pp = parsePartProcesses(ord.part_processes);
        const pq = parsePartDurations(ord.part_quantities);
        const pb = parsePartBuckets(ord.part_buckets);
        for (const p of removeParts) { delete pd[p]; delete pp[p]; delete pq[p]; delete pb[p]; }
        if (keptParts.length === 0 && others.length === 0) {
          await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [orderId] });
          return NextResponse.json({ success: true, deleted: true });
        }
        const total = keptParts.reduce((s, p) => s + (Number(pd[p]) || 0), 0);
        await db.execute({
          sql: 'UPDATE orders SET component = ?, part_durations = ?, part_processes = ?, part_quantities = ?, part_buckets = ?, duration_minutes = ?, status = ? WHERE id = ?',
          args: [keptParts.join(', '), JSON.stringify(pd), JSON.stringify(pp), JSON.stringify(pq), JSON.stringify(pb), total, others.length ? 'scheduled' : 'pending', orderId],
        });
      }
    } else {
      // 통짜(무구성): 남은 엔트리 없으면 주문 삭제, 있으면 소요시간만 차감.
      if (others.length === 0) {
        await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [orderId] });
        return NextResponse.json({ success: true, deleted: true });
      }
      const remain = Math.max(0, (Number(ord.duration_minutes) || 0) - (Number(src.base_minutes) || 0));
      await db.execute({ sql: 'UPDATE orders SET duration_minutes = ? WHERE id = ?', args: [remain, orderId] });
    }
  }

  await recalcMachine(machineId, todayLocal());
  return NextResponse.json({ success: true });
}
