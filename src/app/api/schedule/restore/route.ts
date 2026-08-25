import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

// 되돌리기(Undo) 복원: 클라이언트가 보관한 '이전 상태 스냅샷'으로 해당 라인의
// orders / schedule_entries / buckets 를 정확히 되돌린다.
//  - 스냅샷 행은 upsert(INSERT … ON CONFLICT(id) DO UPDATE)로 원래 id 그대로 복원
//  - 스냅샷에 없는(그 사이 새로 생긴) 행은 삭제(prune)
//  - 컬럼은 PRAGMA table_info로 동적 파악해, 조인으로 섞인 필드(product_name 등)는 무시
// 세션 방식: 이력은 브라우저가 관리하고, 여기서는 '한 스냅샷으로 되돌리는 것'만 담당한다.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const line = String(body?.process_line ?? '');
  const deny = guardLine(req, line);
  if (deny) return deny;
  if (!line) return NextResponse.json({ error: 'no process_line' }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orders: any[] = Array.isArray(body.orders) ? body.orders : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = Array.isArray(body.entries) ? body.entries : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buckets: any[] = Array.isArray(body.buckets) ? body.buckets : [];

  const db = await getDb();

  const colsOf = async (t: string): Promise<Set<string>> =>
    new Set((await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String((r as Record<string, unknown>).name)));
  const idsOf = async (sql: string): Promise<number[]> =>
    (await db.execute({ sql, args: [line] })).rows.map((r) => Number((r as Record<string, unknown>).id)).filter(Number.isFinite);

  // 먼저 필요한 정보를 모두 읽는다(컬럼 목록 + 현재 id들). 이후 쓰기는 한 트랜잭션으로 모아 실행한다.
  const oCols = await colsOf('orders');
  const eCols = await colsOf('schedule_entries');
  const bCols = await colsOf('buckets');
  const machIds = (await db.execute({ sql: 'SELECT id FROM machines WHERE process_line = ?', args: [line] }))
    .rows.map((r) => Number((r as Record<string, unknown>).id)).filter(Number.isFinite);
  const curE = machIds.length
    ? (await db.execute(`SELECT id FROM schedule_entries WHERE machine_id IN (${machIds.join(',')})`)).rows.map((r) => Number((r as Record<string, unknown>).id))
    : [];
  const curO = await idsOf('SELECT id FROM orders WHERE process_line = ?');
  const curB = await idsOf('SELECT id FROM buckets WHERE process_line = ?');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmts: { sql: string; args: any[] }[] = [];
  // 실제 테이블 컬럼만 골라 upsert(원래 id 유지). id 없는 행은 건너뜀.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pushUpsert = (table: string, colSet: Set<string>, rows: any[]) => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const keys = Object.keys(row).filter((k) => colSet.has(k));
      if (!keys.includes('id')) continue;
      const ph = keys.map(() => '?').join(', ');
      const upd = keys.filter((k) => k !== 'id').map((k) => `${k} = excluded.${k}`).join(', ');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = keys.map((k) => (row[k] === undefined ? null : row[k])) as any[];
      const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${ph})` +
        (upd ? ` ON CONFLICT(id) DO UPDATE SET ${upd}` : ` ON CONFLICT(id) DO NOTHING`);
      stmts.push({ sql, args });
    }
  };

  const keepE = new Set(entries.map((e) => Number(e?.id)).filter(Number.isFinite));
  const keepO = new Set(orders.map((o) => Number(o?.id)).filter(Number.isFinite));
  const keepB = new Set(buckets.map((b) => Number(b?.id)).filter(Number.isFinite));

  // 순서: 주문 upsert → 배정 upsert(주문 FK 충족) → 여분 배정 삭제 → 여분 주문 삭제 → 칸 복원/정리.
  pushUpsert('orders', oCols, orders.map((o) => ({ ...o, process_line: line })));
  pushUpsert('schedule_entries', eCols, entries);
  for (const id of curE.filter((id) => !keepE.has(id))) stmts.push({ sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [id] });
  for (const id of curO.filter((id) => !keepO.has(id))) stmts.push({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
  pushUpsert('buckets', bCols, buckets.map((b) => ({ ...b, process_line: line })));
  for (const id of curB.filter((id) => !keepB.has(id))) stmts.push({ sql: 'DELETE FROM buckets WHERE id = ?', args: [id] });

  // 한 트랜잭션으로 원자적 실행(중간 실패 시 전체 롤백 → 부분 손상 방지).
  if (stmts.length) await db.batch(stmts, 'write');

  return NextResponse.json({ success: true });
}
