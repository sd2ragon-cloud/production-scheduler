import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const db = await getDb();
  const processLine = req.nextUrl.searchParams.get('process_line');

  let sql = 'SELECT * FROM orders';
  const args: string[] = [];

  if (processLine) {
    sql += ' WHERE process_line = ?';
    args.push(processLine);
  }
  sql += ' ORDER BY priority DESC, deadline ASC';

  const result = await db.execute({ sql, args });
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();

  const partDurations = body.part_durations && typeof body.part_durations === 'object'
    ? JSON.stringify(body.part_durations)
    : '{}';
  const partProcesses = body.part_processes && typeof body.part_processes === 'object'
    ? JSON.stringify(body.part_processes)
    : '{}';

  const result = await db.execute({
    sql: `INSERT INTO orders (order_code, product_name, component, quantity_sheets, deadline, special_process, priority, notes, duration_minutes, part_durations, part_processes, factory, process_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      body.order_code || '',
      body.product_name,
      body.component || '',
      body.quantity_sheets,
      body.deadline,
      body.special_process ?? '일반',
      body.priority || 5,
      body.notes || '',
      body.duration_minutes || 0,
      partDurations,
      partProcesses,
      body.factory || '본공장',
      body.process_line || '매엽',
    ],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
