import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  const db = getDb();
  const orders = db.prepare('SELECT * FROM orders ORDER BY priority DESC, deadline ASC').all();
  return NextResponse.json(orders);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO orders (order_code, product_name, component, quantity_sheets, deadline, special_process, priority, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    body.order_code || '',
    body.product_name,
    body.component || '',
    body.quantity_sheets,
    body.deadline,
    body.special_process || '일반',
    body.priority || 5,
    body.notes || ''
  );

  return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
}
