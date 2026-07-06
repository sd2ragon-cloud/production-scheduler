import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { guardEntry } from '@/lib/permits';

// 윤전 전용: 설비 배정 항목(schedule_entry)의 '자체 표시값'만 수정한다.
// 원본 주문(orders)은 건드리지 않으므로 1차 배정·배정 대기(같은 주문)는 그대로 유지된다(구역 독립 수정).
export async function POST(req: NextRequest) {
  const { entry_id, product_name, notes, quantity_sheets, duration_minutes } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const srcRes = await db.execute({ sql: 'SELECT machine_id FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcRes.rows[0] as unknown as { machine_id: number } | undefined;
  if (!src) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const dur = Number(duration_minutes);
  const hasDur = Number.isFinite(dur) && dur > 0;

  // 표시값 갱신 + entry_edited=1(이 항목은 주문값 대신 자체값 사용). 소요시간이 오면 base/duration도 갱신.
  await db.execute({
    sql: `UPDATE schedule_entries
          SET entry_product_name = ?, entry_notes = ?, entry_quantity = ?, entry_edited = 1
              ${hasDur ? ', base_minutes = ?, duration_minutes = ?' : ''}
          WHERE id = ?`,
    args: hasDur
      ? [String(product_name ?? ''), String(notes ?? ''), Number(quantity_sheets) || 0, dur, dur, entry_id]
      : [String(product_name ?? ''), String(notes ?? ''), Number(quantity_sheets) || 0, entry_id],
  });

  // 소요시간이 바뀌면 그 설비의 완료시각을 다시 계산한다.
  if (hasDur) await recalcMachine(Number(src.machine_id), todayLocal());

  return NextResponse.json({ success: true });
}
