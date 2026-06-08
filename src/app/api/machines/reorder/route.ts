import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// 설비 표시 순서 변경: 받은 id 배열 순서대로 sort_order를 다시 매긴다.
export async function POST(req: NextRequest) {
  const { ids } = await req.json();
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 });
  }
  const db = await getDb();

  await db.batch(
    ids.map((id: number, i: number) => ({
      sql: 'UPDATE machines SET sort_order = ? WHERE id = ?',
      args: [i + 1, Number(id)],
    })),
    'write',
  );

  return NextResponse.json({ success: true });
}
