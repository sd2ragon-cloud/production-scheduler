import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

export async function GET(req: NextRequest) {
  const db = await getDb();
  const processLine = req.nextUrl.searchParams.get('process_line');

  let sql = 'SELECT * FROM machines';
  const args: string[] = [];

  if (processLine) {
    sql += ' WHERE process_line = ?';
    args.push(processLine);
  }
  sql += ' ORDER BY sort_order, id';

  const result = await db.execute({ sql, args });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  // 새 설비를 등록할 라인을 편집할 권한이 있는지 확인
  const deny = guardLine(req, body.process_line || '매엽');
  if (deny) return deny;
  const db = await getDb();

  // 새 설비는 맨 뒤에 표시되도록 sort_order를 최대값+1로
  const maxResult = await db.execute('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM machines');
  const nextOrder = Number((maxResult.rows[0] as unknown as { max_order: number }).max_order) + 1;

  const result = await db.execute({
    sql: `INSERT INTO machines (name, description, speed_sheets_per_hour, setup_time_minutes, capabilities, work_start_hour, work_end_hour, works_saturday, works_sunday, factory, process_line, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      body.name,
      body.description || '',
      body.speed_sheets_per_hour || 1000,
      body.setup_time_minutes || 30,
      JSON.stringify(body.capabilities || ['일반']),
      body.work_start_hour || 8,
      body.work_end_hour || 22,
      body.works_saturday ? 1 : 0,
      body.works_sunday ? 1 : 0,
      body.factory || '본공장',
      body.process_line || '매엽',
      nextOrder,
    ],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
