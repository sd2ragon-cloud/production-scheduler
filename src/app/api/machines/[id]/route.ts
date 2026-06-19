import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardMachine } from '@/lib/permits';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardMachine(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  await db.execute({
    sql: `UPDATE machines SET name = ?, description = ?, speed_sheets_per_hour = ?, setup_time_minutes = ?, capabilities = ?, work_start_hour = ?, work_end_hour = ?, works_saturday = ?, works_sunday = ?, is_active = ? WHERE id = ?`,
    args: [
      body.name,
      body.description || '',
      body.speed_sheets_per_hour,
      body.setup_time_minutes,
      JSON.stringify(body.capabilities || []),
      body.work_start_hour,
      body.work_end_hour,
      body.works_saturday ? 1 : 0,
      body.works_sunday ? 1 : 0,
      body.is_active ? 1 : 0,
      id,
    ],
  });

  return NextResponse.json({ success: true });
}

// 설비명만 변경 (다른 설정은 유지)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardMachine(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  if (typeof body.name === 'string' && body.name.trim()) {
    await db.execute({ sql: 'UPDATE machines SET name = ? WHERE id = ?', args: [body.name.trim(), id] });
  }

  if (typeof body.memo === 'string') {
    await db.execute({ sql: 'UPDATE machines SET memo = ? WHERE id = ?', args: [body.memo, id] });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardMachine(req, id);
  if (deny) return deny;
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM machines WHERE id = ?', args: [id] });
  return NextResponse.json({ success: true });
}
