import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcAllMachines } from '@/lib/calc';

// 식사시간 수정 (이름/시작/끝). 바뀐 뒤 전 설비의 예상완료시간을 재계산한다.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const db = await getDb();

  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (typeof body.name === 'string') { sets.push('name = ?'); args.push(body.name.trim()); }
  if (body.start_min != null && Number.isFinite(Number(body.start_min))) { sets.push('start_min = ?'); args.push(Number(body.start_min)); }
  if (body.end_min != null && Number.isFinite(Number(body.end_min))) { sets.push('end_min = ?'); args.push(Number(body.end_min)); }

  if (sets.length === 0) return NextResponse.json({ success: true });

  args.push(id);
  await db.execute({ sql: `UPDATE breaks SET ${sets.join(', ')} WHERE id = ?`, args });
  await recalcAllMachines();
  return NextResponse.json({ success: true });
}

// 식사시간 삭제. 삭제 후 전 설비의 예상완료시간을 재계산한다.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM breaks WHERE id = ?', args: [id] });
  await recalcAllMachines();
  return NextResponse.json({ success: true });
}
