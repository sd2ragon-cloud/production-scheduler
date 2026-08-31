import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardOrder } from '@/lib/permits';

// 주문 표시색(mark_color)만 변경 — 신규 주문 분홍 표시를 '확인' 후 지우는 용도(여러 사용자 공유).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();
  if (typeof body.mark_color === 'string') {
    const c = ['', 'rose', 'amber'].includes(body.mark_color) ? body.mark_color : '';
    await db.execute({ sql: 'UPDATE orders SET mark_color = ? WHERE id = ?', args: [c, id] });
  }
  return NextResponse.json({ success: true });
}

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
  const partQuantities = body.part_quantities && typeof body.part_quantities === 'object'
    ? JSON.stringify(body.part_quantities)
    : '{}';

  await db.execute({
    sql: `UPDATE orders SET order_code = ?, product_name = ?, component = ?, quantity_sheets = ?, deadline = ?, special_process = ?, priority = ?, notes = ?, duration_minutes = ?, part_durations = ?, part_processes = ?, part_quantities = ?, extra_notes = ?, status = ? WHERE id = ?`,
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
