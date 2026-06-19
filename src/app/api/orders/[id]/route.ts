import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardOrder } from '@/lib/permits';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  const partDurations = body.part_durations && typeof body.part_durations === 'object'
    ? JSON.stringify(body.part_durations)
    : '{}';
  const partProcesses = body.part_processes && typeof body.part_processes === 'object'
    ? JSON.stringify(body.part_processes)
    : '{}';

  await db.execute({
    sql: `UPDATE orders SET order_code = ?, product_name = ?, component = ?, quantity_sheets = ?, deadline = ?, special_process = ?, priority = ?, notes = ?, duration_minutes = ?, part_durations = ?, part_processes = ?, status = ? WHERE id = ?`,
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
      body.status || 'pending',
      id,
    ],
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
  return NextResponse.json({ success: true });
}
