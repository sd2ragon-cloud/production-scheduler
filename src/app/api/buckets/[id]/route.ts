import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { parsePartBuckets } from '@/lib/parts';
import { guardBucket } from '@/lib/permits';

// 칸 이름 변경
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardBucket(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  if (typeof body.name === 'string' && body.name.trim()) {
    await db.execute({ sql: 'UPDATE buckets SET name = ? WHERE id = ?', args: [body.name.trim(), id] });
  }
  // group_id 변경(분할 묶기/해제). null이면 단독 칸으로.
  if ('group_id' in body) {
    await db.execute({ sql: 'UPDATE buckets SET group_id = ? WHERE id = ?', args: [body.group_id != null ? Number(body.group_id) : null, id] });
  }

  return NextResponse.json({ success: true });
}

// 칸 삭제 — 그 칸에 들어있던 주문/구성은 다시 '배정 대기'로(bucket_id·part_buckets 해제)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardBucket(req, id);
  if (deny) return deny;
  const db = await getDb();
  const bid = Number(id);
  // 제품별(주문 전체) 배정 해제
  await db.execute({ sql: 'UPDATE orders SET bucket_id = NULL WHERE bucket_id = ?', args: [bid] });
  // 구성별 배정 해제: part_buckets에서 이 칸을 가리키던 구성을 명시적 미배정(null)으로
  const r = await db.execute({ sql: "SELECT id, part_buckets FROM orders WHERE part_buckets IS NOT NULL AND part_buckets != '{}'" });
  for (const row of r.rows) {
    const oid = Number((row as unknown as { id: number }).id);
    const map = parsePartBuckets(String((row as unknown as { part_buckets: string }).part_buckets));
    let changed = false;
    for (const k of Object.keys(map)) {
      if (map[k] === bid) { map[k] = null; changed = true; }
    }
    if (changed) {
      await db.execute({ sql: 'UPDATE orders SET part_buckets = ? WHERE id = ?', args: [JSON.stringify(map), oid] });
    }
  }
  await db.execute({ sql: 'DELETE FROM buckets WHERE id = ?', args: [bid] });
  return NextResponse.json({ success: true });
}
