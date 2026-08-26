import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(req: NextRequest) {
  const db = await getDb();
  const processLine = req.nextUrl.searchParams.get('process_line');

  // 윤전 전용: entry_edited=1인 항목은 자체 표시값(entry_*)을 쓰고, 아니면 주문값을 쓴다.
  // (설비 배정 항목을 원본 주문과 분리해 각 구역 독립 수정이 가능하게 함)
  let sql = `
    SELECT
      se.*,
      CASE WHEN se.entry_edited = 1 THEN se.entry_product_name ELSE o.product_name END as product_name,
      o.component,
      CASE WHEN se.entry_edited = 1 THEN se.entry_quantity ELSE o.quantity_sheets END as quantity_sheets,
      o.deadline,
      o.special_process,
      o.part_processes,
      o.priority,
      CASE WHEN se.entry_notes_edited = 1 THEN se.entry_notes ELSE o.notes END as order_notes,
      o.extra_notes as order_extra,
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
