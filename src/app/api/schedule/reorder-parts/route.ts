import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { parseParts } from '@/lib/parts';

// 병합된 한 행(엔트리) 안에서 파트 순서를 재정렬한다.
export async function POST(req: NextRequest) {
  const { entry_id, parts } = await req.json();
  const db = await getDb();

  const result = await db.execute({ sql: 'SELECT component_part FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const row = result.rows[0] as unknown as { component_part: string } | undefined;
  if (!row) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // 기존 파트 집합과 동일한 구성인지 검증(누락/추가 방지)
  const existing = parseParts(String(row.component_part));
  const requested = Array.isArray(parts) ? parts.map((p) => String(p).trim()).filter(Boolean) : [];
  const sameSet =
    existing.length === requested.length && existing.every((p) => requested.includes(p));
  if (!sameSet) {
    return NextResponse.json({ error: 'parts mismatch' }, { status: 400 });
  }

  await db.execute({
    sql: 'UPDATE schedule_entries SET component_part = ? WHERE id = ?',
    args: [requested.join(', '), entry_id],
  });

  return NextResponse.json({ success: true });
}
