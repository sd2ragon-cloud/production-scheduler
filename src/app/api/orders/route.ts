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
  // 수기 정렬(sort_order)이 우선. 같은 값이면 기존 기준(priority, deadline, id)으로.
  sql += ' ORDER BY sort_order ASC, priority DESC, deadline ASC, id ASC';

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

  // 새 주문은 해당 라인 배정 대기의 맨 아래에 오도록 sort_order를 최대값+1로.
  const maxRes = await db.execute({ sql: 'SELECT COALESCE(MAX(sort_order), 0) as m FROM orders WHERE process_line = ?', args: [body.process_line || '매엽'] });
  const nextSort = Number((maxRes.rows[0] as unknown as { m: number }).m) + 1;

  const result = await db.execute({
    // 신규 주문은 배정대기에서 분홍(rose)으로 표시 → 다른 사용자가 새로 추가된 걸 바로 알아보게 함.
    sql: `INSERT INTO orders (order_code, product_name, component, quantity_sheets, deadline, special_process, priority, notes, duration_minutes, part_durations, part_processes, part_quantities, extra_notes, factory, process_line, sort_order, mark_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      body.order_code || '',
      body.product_name,
      body.component || '',
      body.quantity_sheets,
      body.deadline || '',
      body.special_process ?? '일반',
      body.priority || 5,
      body.notes || '',
      body.duration_minutes || 0,
      partDurations,
      partProcesses,
      partQuantities,
      body.extra_notes || '',
      body.factory || '본공장',
      body.process_line || '매엽',
      nextSort,
      'rose',
    ],
  });

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
