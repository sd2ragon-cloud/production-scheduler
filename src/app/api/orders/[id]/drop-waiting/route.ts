import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardOrder } from '@/lib/permits';
import { parsePartBuckets, parsePartProcesses } from '@/lib/parts';

// 배정 대기 카드 삭제: 미배정(대기) 구성만 주문에서 제거하고, 설비에 배정된 구성·1차 배정 칸 구성은 유지한다.
// body: { keep: { 구성명: 유지할_base분 } }  → keep의 구성만 남기고(스펙에서 나머지 제거), keep이 비면 주문 전체 삭제.
// 대기 구성은 어떤 설비에도 배정돼 있지 않으므로 재계산은 불필요하다.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const { keep } = await req.json();
  const db = await getDb();

  const row = (await db.execute({ sql: 'SELECT part_buckets, part_processes, part_quantities FROM orders WHERE id = ?', args: [id] }))
    .rows[0] as unknown as { part_buckets: string; part_processes: string; part_quantities: string } | undefined;
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const keepMap = keep && typeof keep === 'object' ? (keep as Record<string, unknown>) : {};
  const names = Object.keys(keepMap).map((n) => n.trim()).filter(Boolean);

  // 남길 구성이 하나도 없으면(전부 대기였음) 주문 전체 삭제.
  if (names.length === 0) {
    await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
    return NextResponse.json({ success: true, deleted: true });
  }

  const durs: Record<string, number> = {};
  let total = 0;
  for (const n of names) {
    const m = Math.max(0, Math.round(Number(keepMap[n]) || 0));
    durs[n] = m;
    total += m;
  }
  const nameSet = new Set(names);
  const filterMap = <T,>(obj: Record<string, T>): Record<string, T> => {
    const o: Record<string, T> = {};
    for (const [k, v] of Object.entries(obj)) if (nameSet.has(k)) o[k] = v;
    return o;
  };
  const buckets = filterMap(parsePartBuckets(row.part_buckets));
  const procs = filterMap(parsePartProcesses(row.part_processes));
  let quantities: Record<string, unknown> = {};
  try {
    const q = JSON.parse(row.part_quantities || '{}');
    if (q && typeof q === 'object') quantities = filterMap(q as Record<string, unknown>);
  } catch { /* 무시 */ }

  await db.execute({
    sql: `UPDATE orders SET component = ?, part_durations = ?, duration_minutes = ?, part_buckets = ?, part_processes = ?, part_quantities = ?, status = ? WHERE id = ?`,
    args: [
      names.join(', '),
      JSON.stringify(durs),
      total,
      JSON.stringify(buckets),
      JSON.stringify(procs),
      JSON.stringify(quantities),
      'scheduled',
      id,
    ],
  });
  return NextResponse.json({ success: true });
}
