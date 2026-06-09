import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// 칸 이름 변경
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const db = await getDb();

  if (typeof body.name === 'string' && body.name.trim()) {
    await db.execute({ sql: 'UPDATE buckets SET name = ? WHERE id = ?', args: [body.name.trim(), id] });
  }

  return NextResponse.json({ success: true });
}

// 칸 삭제 — 그 칸에 들어있던 주문은 다시 '배정 대기'로(bucket_id 해제)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  await db.execute({ sql: 'UPDATE orders SET bucket_id = NULL WHERE bucket_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM buckets WHERE id = ?', args: [id] });
  return NextResponse.json({ success: true });
}
