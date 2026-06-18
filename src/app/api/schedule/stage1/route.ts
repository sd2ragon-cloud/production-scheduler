import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { parsePartBuckets } from '@/lib/parts';

// 1차 배정. 두 가지 방식을 지원한다:
//  - 제품별: { order_id, bucket_id }            → orders.bucket_id 설정/해제(null). 구성 매핑은 초기화.
//  - 구성별: { order_id, bucket_id, parts:[...] } → part_buckets 맵에 각 구성→칸(or null) 기록.
//            (part_buckets에 없는 구성은 표시 시 bucket_id로 폴백된다.)
// bucket_id가 NULL이면 '배정 대기'로, 값이 있으면 해당 칸에 표시된다.
export async function POST(req: NextRequest) {
  const { order_id, bucket_id, parts } = await req.json();
  if (order_id == null) {
    return NextResponse.json({ error: 'order_id required' }, { status: 400 });
  }
  const db = await getDb();
  const oid = Number(order_id);
  const bid = bucket_id == null ? null : Number(bucket_id);

  if (Array.isArray(parts) && parts.length > 0) {
    // 구성별: 기존 맵을 읽어 지정한 구성만 갱신(나머지 구성은 그대로 유지).
    const r = await db.execute({ sql: 'SELECT part_buckets FROM orders WHERE id = ?', args: [oid] });
    if (r.rows.length === 0) {
      return NextResponse.json({ error: 'order not found' }, { status: 404 });
    }
    const map = parsePartBuckets(String((r.rows[0] as unknown as { part_buckets: string }).part_buckets));
    for (const p of parts) {
      if (typeof p === 'string' && p) map[p] = bid; // bid가 null이면 명시적 미배정(대기)
    }
    await db.execute({ sql: 'UPDATE orders SET part_buckets = ? WHERE id = ?', args: [JSON.stringify(map), oid] });
    return NextResponse.json({ success: true });
  }

  // 제품별: 주문 전체를 한 칸으로(또는 대기로). 구성별 매핑은 초기화하여 전부 bucket_id를 따르게 한다.
  await db.execute({ sql: 'UPDATE orders SET bucket_id = ?, part_buckets = ? WHERE id = ?', args: [bid, '{}', oid] });
  return NextResponse.json({ success: true });
}
