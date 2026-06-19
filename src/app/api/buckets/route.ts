import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

// 1차 배정 칸(buckets) 목록. 공정 라인별로 필터.
export async function GET(req: NextRequest) {
  const db = await getDb();
  const processLine = req.nextUrl.searchParams.get('process_line');

  let sql = 'SELECT * FROM buckets';
  const args: string[] = [];
  if (processLine) {
    sql += ' WHERE process_line = ?';
    args.push(processLine);
  }
  sql += ' ORDER BY sort_order, id';

  const result = await db.execute({ sql, args });
  return NextResponse.json(result.rows);
}

// 새 칸 추가 (맨 뒤 순서로)
export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();

  if (!body.name || !String(body.name).trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }

  const deny = guardLine(req, body.process_line || '매엽');
  if (deny) return deny;

  const maxResult = await db.execute('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM buckets');
  const nextOrder = Number((maxResult.rows[0] as unknown as { max_order: number }).max_order) + 1;

  const result = await db.execute({
    sql: `INSERT INTO buckets (name, process_line, sort_order) VALUES (?, ?, ?)`,
    args: [String(body.name).trim(), body.process_line || '매엽', nextOrder],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
