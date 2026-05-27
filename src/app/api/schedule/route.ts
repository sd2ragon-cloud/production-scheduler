import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  const db = getDb();

  const entries = db.prepare(`
    SELECT
      se.*,
      o.product_name,
      o.component,
      o.quantity_sheets,
      o.deadline,
      o.special_process,
      o.priority,
      o.notes as order_notes,
      m.name as machine_name
    FROM schedule_entries se
    JOIN orders o ON se.order_id = o.id
    JOIN machines m ON se.machine_id = m.id
    ORDER BY m.id, se.sequence
  `).all();

  return NextResponse.json(entries);
}
