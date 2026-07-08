import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, sumDurations } from '@/lib/parts';
import { guardEntry } from '@/lib/permits';

export async function POST(req: NextRequest) {
  const { entry_id } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const entryResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const entry = entryResult.rows[0] as unknown as { id: number; order_id: number; machine_id: number; sequence: number; component_part: string; part_durations: string } | undefined;

  if (!entry) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // 이 엔트리의 구성이 주문 사양(component)에 없으면(설비 수정에서 직접 추가한 구성 등) 대기로 되돌릴 때 사라진다.
  // 대기로 복귀시키는 것이므로 주문 사양에 없는 구성은 추가해 배정 대기에 보이게 한다.
  const entParts = parseParts(String(entry.component_part));
  if (entParts.length > 0) {
    const ordRes0 = await db.execute({ sql: 'SELECT component, part_durations FROM orders WHERE id = ?', args: [Number(entry.order_id)] });
    const ord0 = ordRes0.rows[0] as unknown as { component: string; part_durations: string } | undefined;
    if (ord0) {
      const oc = parseParts(String(ord0.component));
      const opd = parsePartDurations(ord0.part_durations);
      const entPd = parsePartDurations(entry.part_durations);
      let changed = false;
      for (const p of entParts) {
        if (!oc.includes(p)) { oc.push(p); if (!(p in opd)) opd[p] = Number(entPd[p]) || 0; changed = true; }
      }
      if (changed) {
        await db.execute({
          sql: 'UPDATE orders SET component = ?, part_durations = ?, duration_minutes = ? WHERE id = ?',
          args: [oc.join(', '), JSON.stringify(opd), sumDurations(opd), Number(entry.order_id)],
        });
      }
    }
  }

  await db.batch([
    { sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [entry_id] },
    { sql: "UPDATE orders SET status = 'pending' WHERE id = ?", args: [Number(entry.order_id)] },
    { sql: 'UPDATE schedule_entries SET sequence = sequence - 1 WHERE machine_id = ? AND sequence > ?', args: [Number(entry.machine_id), Number(entry.sequence)] },
  ], 'write');

  const today = todayLocal();
  await recalcMachine(Number(entry.machine_id), today);

  return NextResponse.json({ success: true });
}
