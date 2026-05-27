import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();

  db.prepare(`
    UPDATE orders SET
      order_code = ?, product_name = ?, component = ?, quantity_sheets = ?,
      deadline = ?, special_process = ?, priority = ?, notes = ?, status = ?
    WHERE id = ?
  `).run(
    body.order_code || '',
    body.product_name,
    body.component || '',
    body.quantity_sheets,
    body.deadline,
    body.special_process || '일반',
    body.priority || 5,
    body.notes || '',
    body.status || 'pending',
    id
  );

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  return NextResponse.json({ success: true });
}
