import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAdminRole } from '@/lib/auth-token';

// 진단용: 이름으로 주문을 찾아 원본(구성·파트별 소요시간·1차배정·상태)과 모든 배정 엔트리를 보여준다.
// 브라우저 주소창에 .../api/debug/order?name=국어5-2 나  로 접속(관리자 로그인 필요).
export async function GET(req: NextRequest) {
  if (!getAdminRole(req)) return NextResponse.json({ error: '관리자 로그인이 필요합니다.' }, { status: 403 });
  const name = (req.nextUrl.searchParams.get('name') || '').trim() || '국어5-2';
  const db = await getDb();
  const orders = (await db.execute({
    sql: `SELECT id, product_name, process_line, component, part_durations, part_processes, part_buckets, bucket_id, status, duration_minutes
          FROM orders WHERE product_name LIKE ? ORDER BY id`,
    args: [`%${name}%`],
  })).rows;
  const out = [];
  for (const o of orders) {
    const entries = (await db.execute({
      sql: `SELECT se.id, se.machine_id, m.name AS machine, m.is_active, se.component_part, se.part_durations, se.duration_minutes, se.sequence
            FROM schedule_entries se LEFT JOIN machines m ON se.machine_id = m.id
            WHERE se.order_id = ? ORDER BY se.machine_id, se.sequence`,
      args: [(o as unknown as { id: number }).id],
    })).rows;
    out.push({ order: o, entries });
  }
  return NextResponse.json({ name, count: orders.length, result: out });
}
