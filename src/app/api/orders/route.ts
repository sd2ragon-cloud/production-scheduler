import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

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
  // 새 주문을 만들 라인을 편집할 권한이 있는지 확인
  const deny = guardLine(req, body.process_line || '매엽');
  if (deny) return deny;
  const db = await getDb();

  const partDurations = body.part_durations && typeof body.part_durations === 'object'
    ? JSON.stringify(body.part_durations)
    : '{}';
  const partProcesses = body.part_processes && typeof body.part_processes === 'object'
    ? JSON.stringify(body.part_processes)
    : '{}';
  const partQuantities = body.part_quantities && typeof body.part_quantities === 'object'
    ? JSON.stringify(body.part_quantities)
    : '{}';

  const result = await db.execute({
    sql: `INSERT INTO orders (order_code, product_name, component, quantity_sheets, deadline, special_process, priority, notes, duration_minutes, part_durations, part_processes, part_quantities, factory, process_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      partQuantities,
      body.factory || '본공장',
      body.process_line || '매엽',
    ],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
