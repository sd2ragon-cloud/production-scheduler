import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcAllMachines } from '@/lib/calc';

// 식사·휴게 시간 목록 (이른 시각 순). 자정 기준 분 단위 start_min/end_min.
export async function GET() {
  const db = await getDb();
  const result = await db.execute('SELECT * FROM breaks ORDER BY start_min, id');
  return NextResponse.json(result.rows);
}

// 새 식사시간 추가. 추가 후 전 설비의 예상완료시간을 재계산한다.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();

  const name = String(body.name ?? '').trim();
  const start = Number(body.start_min);
  const end = Number(body.end_min);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1440 || end <= start) {
    return NextResponse.json({ error: 'invalid time range' }, { status: 400 });
  }

  const result = await db.execute({
    sql: 'INSERT INTO breaks (name, start_min, end_min) VALUES (?, ?, ?)',
    args: [name, start, end],
  });

  await recalcAllMachines();
  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
