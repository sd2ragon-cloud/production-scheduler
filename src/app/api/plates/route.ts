import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAdminRole } from '@/lib/auth-token';
import { ROLE_LABELS } from '@/lib/factory-config';
import { PLATE_LINES, PLATE_LEAD_MIN } from '@/lib/plates';

// CTP 판 출력 화면용.
//  GET  : 매엽·윤전 전 설비의 배정 항목을 시작시각 순으로(판 필요 시각 = 시작 - PLATE_LEAD_MIN분)
//  POST : { entry_ids: number[], done: boolean } 판 출력완료 체크/해제 (CTP 담당자·매엽윤전 관리자)
export const dynamic = 'force-dynamic';

const inList = PLATE_LINES.map(() => '?').join(',');

export async function GET() {
  const db = await getDb();
  const r = await db.execute({
    sql: `
      SELECT
        se.id, se.machine_id, se.sequence, se.start_time, se.end_time, se.component_part,
        se.plate_done_at, se.plate_done_by, se.changed_at, se.change_note,
        CASE WHEN se.entry_edited = 1 THEN se.entry_product_name ELSE o.product_name END AS product_name,
        CASE WHEN se.entry_edited = 1 THEN se.entry_quantity ELSE o.quantity_sheets END AS quantity,
        CASE WHEN se.entry_notes_edited = 1 THEN se.entry_notes ELSE o.notes END AS notes,
        o.component,
        m.name AS machine_name, m.process_line, m.sort_order AS machine_order
      FROM schedule_entries se
      JOIN orders o ON se.order_id = o.id
      JOIN machines m ON se.machine_id = m.id
      WHERE m.is_active = 1 AND m.process_line IN (${inList})
      ORDER BY CASE WHEN se.start_time = '' THEN 1 ELSE 0 END, se.start_time, m.sort_order, m.id, se.sequence`,
    args: PLATE_LINES,
  });
  return NextResponse.json({ lead_min: PLATE_LEAD_MIN, lines: PLATE_LINES, entries: r.rows });
}

export async function POST(req: NextRequest) {
  const role = getAdminRole(req);
  if (role !== 'ctp' && role !== 'sheet') {
    return NextResponse.json({ error: 'CTP 담당자 또는 매엽·윤전 관리자만 체크할 수 있습니다.' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const ids = (Array.isArray(body.entry_ids) ? body.entry_ids : [body.entry_id])
    .map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return NextResponse.json({ error: '대상이 없습니다.' }, { status: 400 });
  const done = body.done !== false;

  const db = await getDb();
  // 매엽·윤전 설비의 항목만 허용
  const ok = await db.execute({
    sql: `SELECT se.id FROM schedule_entries se JOIN machines m ON se.machine_id = m.id
          WHERE se.id IN (${ids.map(() => '?').join(',')}) AND m.process_line IN (${inList})`,
    args: [...ids, ...PLATE_LINES],
  });
  const valid = ok.rows.map((x) => Number((x as Record<string, unknown>).id));
  if (valid.length === 0) return NextResponse.json({ error: '대상을 찾을 수 없습니다.' }, { status: 404 });

  const deviceName = decodeURIComponent(req.cookies.get('ps_device_name')?.value || '');
  const by = (deviceName || ROLE_LABELS[role]).slice(0, 64);
  await db.batch(
    valid.map((id) => done
      ? { sql: `UPDATE schedule_entries SET plate_done_at = datetime('now', 'localtime'), plate_done_by = ? WHERE id = ?`, args: [by, id] }
      : { sql: `UPDATE schedule_entries SET plate_done_at = '', plate_done_by = '' WHERE id = ?`, args: [id] }),
    'write',
  );
  return NextResponse.json({ success: true, count: valid.length });
}
