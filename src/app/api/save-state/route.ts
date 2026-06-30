import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

// '저장' = 확정 시점. 그 라인의 현재 상태(설비별 배정 엔트리 + 주문)를 스냅샷으로 settings에 보관하고,
// 마지막 저장 시각도 기록한다. 이후 '되돌리기'를 누르면 이 스냅샷으로 복원한다.
function stampNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const line = String(body.process_line || '매엽');
  const deny = guardLine(req, line);
  if (deny) return deny;

  const db = await getDb();
  const mids = (await db.execute({ sql: 'SELECT id FROM machines WHERE process_line = ?', args: [line] }))
    .rows.map((r) => Number((r as unknown as { id: number }).id));
  let entries: unknown[] = [];
  if (mids.length) {
    const inC = `(${mids.map(() => '?').join(',')})`;
    entries = (await db.execute({ sql: `SELECT * FROM schedule_entries WHERE machine_id IN ${inC}`, args: mids })).rows;
  }
  const orders = (await db.execute({ sql: 'SELECT * FROM orders WHERE process_line = ?', args: [line] })).rows;

  const at = stampNow();
  const snapshot = JSON.stringify({ at, entries, orders });
  await db.execute({ sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [`snapshot_${line}`, snapshot] });
  await db.execute({ sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [`saved_at_${line}`, at] });
  return NextResponse.json({ saved_at: at });
}
