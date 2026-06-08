import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const db = await getDb();
  const processLine = req.nextUrl.searchParams.get('process_line');

  let sql = `
    SELECT
      se.*,
      o.product_name,
      o.component,
      o.quantity_sheets,
      o.deadline,
      o.special_process,
      o.part_processes,
      o.priority,
      o.notes as order_notes,
      m.name as machine_name
    FROM schedule_entries se
    JOIN orders o ON se.order_id = o.id
    JOIN machines m ON se.machine_id = m.id`;

  const args: string[] = [];

  if (processLine) {
    sql += ' WHERE m.process_line = ?';
    args.push(processLine);
  }

  sql += ' ORDER BY m.id, se.sequence';

  const result = await db.execute({ sql, args });
  return NextResponse.json(result.rows);
}
