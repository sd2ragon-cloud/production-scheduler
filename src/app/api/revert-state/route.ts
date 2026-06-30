import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';
import { recalcMachine } from '@/lib/calc';

// '되돌리기' = 마지막 저장 스냅샷으로 그 라인을 복원한다.
//  1) 라인 설비의 현재 배정 엔트리를 모두 삭제하고 스냅샷 엔트리로 되돌림.
//  2) 스냅샷 주문(전체 컬럼)으로 되돌림. 스냅샷 이후 새로 만든 주문은 미배정(pending)으로.
//  3) 라인 설비 재계산.
type Row = Record<string, unknown>;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const line = String(body.process_line || '매엽');
  const deny = guardLine(req, line);
  if (deny) return deny;

  const db = await getDb();
  const snapRow = (await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [`snapshot_${line}`] })).rows[0];
  if (!snapRow) return NextResponse.json({ error: 'no snapshot' }, { status: 400 });
  let snap: { entries?: Row[]; orders?: Row[] };
  try {
    snap = JSON.parse(String((snapRow as unknown as { value: string }).value));
  } catch {
    return NextResponse.json({ error: 'bad snapshot' }, { status: 500 });
  }

  const mids = (await db.execute({ sql: 'SELECT id FROM machines WHERE process_line = ?', args: [line] }))
    .rows.map((r) => Number((r as unknown as { id: number }).id));

  // 1) 라인 설비의 현재 엔트리 제거
  if (mids.length) {
    const inC = `(${mids.map(() => '?').join(',')})`;
    await db.execute({ sql: `DELETE FROM schedule_entries WHERE machine_id IN ${inC}`, args: mids });
  }
  // 2) 스냅샷 엔트리 재삽입(원래 컬럼 그대로)
  for (const e of (snap.entries || [])) {
    const cols = Object.keys(e);
    if (!cols.length) continue;
    await db.execute({
      sql: `INSERT INTO schedule_entries (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      args: cols.map((c) => e[c] as string | number | null),
    });
  }
  // 3) 스냅샷 주문 복원(전체 컬럼) + 이후 추가된 주문은 미배정 처리
  const snapIds: number[] = [];
  for (const o of (snap.orders || [])) {
    const id = Number(o.id);
    if (!Number.isFinite(id)) continue;
    snapIds.push(id);
    const cols = Object.keys(o).filter((c) => c !== 'id');
    if (!cols.length) continue;
    await db.execute({
      sql: `UPDATE orders SET ${cols.map((c) => `"${c}"=?`).join(',')} WHERE id = ?`,
      args: [...cols.map((c) => o[c] as string | number | null), id],
    });
  }
  const notIn = snapIds.length ? `AND id NOT IN (${snapIds.map(() => '?').join(',')})` : '';
  await db.execute({ sql: `UPDATE orders SET status='pending', bucket_id=NULL, part_buckets='{}' WHERE process_line = ? ${notIn}`, args: [line, ...snapIds] });

  // 4) 재계산
  const today = new Date().toISOString().split('T')[0];
  for (const mid of mids) await recalcMachine(mid, today);

  return NextResponse.json({ success: true });
}
