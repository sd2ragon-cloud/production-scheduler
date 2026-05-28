import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const db = await getDb();
  const factory = req.nextUrl.searchParams.get('factory');
  const processLine = req.nextUrl.searchParams.get('process_line');

  let sql = 'SELECT * FROM machines';
  const args: string[] = [];

  if (factory && processLine) {
    sql += ' WHERE factory = ? AND process_line = ?';
    args.push(factory, processLine);
  }
  sql += ' ORDER BY id';

  const result = await db.execute({ sql, args });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();

  const result = await db.execute({
    sql: `INSERT INTO machines (name, description, speed_sheets_per_hour, setup_time_minutes, capabilities, work_start_hour, work_end_hour, works_saturday, works_sunday, factory, process_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
