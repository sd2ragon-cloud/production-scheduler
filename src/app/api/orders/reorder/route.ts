import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

// 배정 대기 등에서 주문 카드 순서를 수기로 바꾼다.
// body: { ids: number[], process_line }  ids = 새 순서(그 라인의 재정렬 대상 주문 id들).
// 이 id들이 현재 가진 sort_order '슬롯'을 모아 정렬한 뒤 새 순서대로 재배분한다.
// (재정렬 대상이 아닌 주문의 위치는 그대로 두고, 대상들만 자기들끼리 순서를 바꿈)
export async function POST(req: NextRequest) {
  const { ids, process_line } = await req.json();
  const deny = guardLine(req, process_line || '매엽');
  if (deny) return deny;
  if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ success: true });
  const orderIds = ids.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (orderIds.length === 0) return NextResponse.json({ success: true });
  const db = await getDb();

  const placeholders = orderIds.map(() => '?').join(',');
  const rows = await db.execute({ sql: `SELECT id, sort_order FROM orders WHERE id IN (${placeholders})`, args: orderIds });
  const slots = (rows.rows as unknown as { sort_order: number }[]).map((r) => Number(r.sort_order)).sort((a, b) => a - b);

  await db.batch(
    orderIds.map((id, i) => ({ sql: 'UPDATE orders SET sort_order = ? WHERE id = ?', args: [slots[i] ?? i, id] })),
    'write',
  );
  return NextResponse.json({ success: true });
}
