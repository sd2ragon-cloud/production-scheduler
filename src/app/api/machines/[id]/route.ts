import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardMachine } from '@/lib/permits';
import { recalcMachine } from '@/lib/calc';

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

  if (typeof body.extra_notes === 'string') {
    await db.execute({ sql: 'UPDATE machines SET extra_notes = ? WHERE id = ?', args: [body.extra_notes, id] });
  }

  // 근무 시작/종료 시각 변경 → 예상완료시간이 달라지므로 이 설비 일정을 재계산한다.
  let recalcNeeded = false;
  if (body.work_start_hour != null && Number.isFinite(Number(body.work_start_hour))) {
    await db.execute({ sql: 'UPDATE machines SET work_start_hour = ? WHERE id = ?', args: [Number(body.work_start_hour), id] });
    recalcNeeded = true;
  }
  if (body.work_end_hour != null && Number.isFinite(Number(body.work_end_hour))) {
    await db.execute({ sql: 'UPDATE machines SET work_end_hour = ? WHERE id = ?', args: [Number(body.work_end_hour), id] });
    recalcNeeded = true;
  }
  // 휴무 요일 변경 → 예상완료시간 재계산. 0~6만, 7요일 전체 휴무는 막는다(최소 1일 근무).
  if (Array.isArray(body.off_days)) {
    let off = Array.from(new Set(body.off_days.map(Number).filter((n: number) => n >= 0 && n <= 6)));
    if (off.length >= 7) off = off.slice(0, 6);
    await db.execute({ sql: 'UPDATE machines SET off_days = ? WHERE id = ?', args: [JSON.stringify(off), id] });
    recalcNeeded = true;
  }
  if (recalcNeeded) {
    await recalcMachine(Number(id), new Date().toISOString().split('T')[0]);
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
