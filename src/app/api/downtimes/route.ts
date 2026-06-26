import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardMachine } from '@/lib/permits';
import { recalcMachine } from '@/lib/calc';

// 설비별 비가동시간 목록. machine_id로 필터(없으면 전체).
export async function GET(req: NextRequest) {
  const db = await getDb();
  const mid = req.nextUrl.searchParams.get('machine_id');
  const result = mid
    ? await db.execute({ sql: 'SELECT * FROM downtimes WHERE machine_id = ? ORDER BY start_time', args: [Number(mid)] })
    : await db.execute('SELECT * FROM downtimes ORDER BY start_time');
  return NextResponse.json(result.rows);
}

// 비가동시간 추가. start_time/end_time = "YYYY-MM-DD HH:MM". 추가 후 해당 설비 재계산.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const machineId = Number(body.machine_id);
  const deny = await guardMachine(req, machineId);
  if (deny) return deny;

  const start = String(body.start_time ?? '').trim();
  const end = String(body.end_time ?? '').trim();
  const reason = String(body.reason ?? '').trim();
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s);
  if (!ok(start) || !ok(end) || new Date(end.replace(' ', 'T')) <= new Date(start.replace(' ', 'T'))) {
    return NextResponse.json({ error: 'invalid time range' }, { status: 400 });
  }
  const norm = (s: string) => s.replace('T', ' ').slice(0, 16);

  const db = await getDb();
  const result = await db.execute({
    sql: 'INSERT INTO downtimes (machine_id, start_time, end_time, reason) VALUES (?, ?, ?, ?)',
    args: [machineId, norm(start), norm(end), reason],
  });

  await recalcMachine(machineId, new Date().toISOString().split('T')[0]);
  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
