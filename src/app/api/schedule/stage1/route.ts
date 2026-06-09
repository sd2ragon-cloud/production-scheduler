import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// 1차 배정: 주문을 특정 칸(국/4×6/MB6/HDP ...)에 넣거나(bucket_id 지정) 해제(null)한다.
// bucket_id가 NULL이면 '배정 대기'로, 값이 있으면 해당 칸에 표시된다.
export async function POST(req: NextRequest) {
  const { order_id, bucket_id } = await req.json();
  if (order_id == null) {
    return NextResponse.json({ error: 'order_id required' }, { status: 400 });
  }
  const db = await getDb();
  const bid = bucket_id == null ? null : Number(bucket_id);
  await db.execute({ sql: 'UPDATE orders SET bucket_id = ? WHERE id = ?', args: [bid, Number(order_id)] });
  return NextResponse.json({ success: true });
}
