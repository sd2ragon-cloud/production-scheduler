import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardOrder } from '@/lib/permits';
import { logAudit } from '@/lib/audit';

// 화면에서 사람이 보고 고치는 값들. 저장 시 '내가 창을 연 시점의 값(base)'과 비교해
// 그 사이 다른 사용자가 바꿨는지 판정하고, 수정 이력도 이 목록 기준으로 남긴다.
const WATCHED: { key: string; label: string }[] = [
  { key: 'product_name', label: '제품명' },
  { key: 'component', label: '구성' },
  { key: 'quantity_sheets', label: '부수' },
  { key: 'deadline', label: '납기' },
  { key: 'special_process', label: '특수공정' },
  { key: 'priority', label: '우선순위' },
  { key: 'notes', label: '비고' },
  { key: 'extra_notes', label: '추가비고' },
];

// 단건 조회 — 수정창을 열 때 그 주문만 다시 읽어, 다른 사용자가 방금 바꾼 값 위에서 편집하게 한다.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(row);
}

// 주문 표시색(mark_color)만 변경 — 신규 주문 분홍 표시를 '확인' 후 지우는 용도(여러 사용자 공유).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();
  if (typeof body.mark_color === 'string') {
    const c = ['', 'rose', 'amber'].includes(body.mark_color) ? body.mark_color : '';
    await db.execute({ sql: 'UPDATE orders SET mark_color = ? WHERE id = ?', args: [c, id] });
  }
  return NextResponse.json({ success: true });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  const partDurations = body.part_durations && typeof body.part_durations === 'object'
    ? JSON.stringify(body.part_durations)
    : '{}';
  const partProcesses = body.part_processes && typeof body.part_processes === 'object'
    ? JSON.stringify(body.part_processes)
    : '{}';
  const partQuantities = body.part_quantities && typeof body.part_quantities === 'object'
    ? JSON.stringify(body.part_quantities)
    : '{}';

  const curRes = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const cur = curRes.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!cur) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const nextVals: Record<string, unknown> = {
    product_name: body.product_name,
    component: body.component || '',
    quantity_sheets: body.quantity_sheets,
    deadline: body.deadline || '',
    special_process: body.special_process ?? '일반',
    priority: body.priority || 5,
    notes: body.notes || '',
    extra_notes: body.extra_notes || '',
  };

  // 동시 편집 덮어쓰기 방지.
  // 화면이 자동 갱신되지 않으므로 각자 브라우저는 낡은 주문 값을 들고 있을 수 있고, 저장은 전체 필드를
  // 통째로 덮어쓴다. 그래서 제품명을 건드리지도 않은 사람의 저장이 다른 사람의 제품명 수정을 되돌리는
  // 일이 생겼다. 여기서 '창을 연 시점의 값(base)'과 현재 DB 값을 비교해, 그 사이 남이 바꾼 필드를
  // 내가 다른 값으로 덮어쓰려는 경우에만 409로 막는다(같은 값을 쓰는 건 무해하므로 통과).
  const base = body.base && typeof body.base === 'object' ? (body.base as Record<string, unknown>) : null;
  const forced = body.force === true;
  if (base && !forced) {
    const conflicts: { field: string; label: string; theirs: string; mine: string }[] = [];
    for (const { key, label } of WATCHED) {
      if (!(key in base)) continue;
      const b = String(base[key] ?? '');
      const c = String(cur[key] ?? '');
      const n = String(nextVals[key] ?? '');
      if (c !== b && n !== c) conflicts.push({ field: key, label, theirs: c, mine: n });
    }
    if (conflicts.length) {
      return NextResponse.json({ error: 'conflict', conflicts }, { status: 409 });
    }
  }

  await db.execute({
    sql: `UPDATE orders SET order_code = ?, product_name = ?, component = ?, quantity_sheets = ?, deadline = ?, special_process = ?, priority = ?, notes = ?, duration_minutes = ?, part_durations = ?, part_processes = ?, part_quantities = ?, extra_notes = ?, status = ? WHERE id = ?`,
    args: [
      body.order_code || '',
      body.product_name,
      body.component || '',
      body.quantity_sheets,
      body.deadline || '',
      body.special_process ?? '일반',
      body.priority || 5,
      body.notes || '',
      body.duration_minutes || 0,
      partDurations,
      partProcesses,
      partQuantities,
      body.extra_notes || '',
      body.status || 'pending',
      id,
    ],
  });

  // 수정 이력: 바뀐 필드만 '이전 → 이후'로 남긴다(누가·언제·어느 PC인지는 logAudit이 붙인다).
  const changes: string[] = [];
  for (const { key, label } of WATCHED) {
    const before = String(cur[key] ?? '');
    const after = String(nextVals[key] ?? '');
    if (before !== after) changes.push(`${label}: '${before}' → '${after}'`);
  }
  if (changes.length) {
    await logAudit(req, {
      action: forced ? 'order_edit_force' : 'order_edit',
      line: String(cur.process_line ?? ''),
      target: `주문 수정: ${cur.product_name ?? '(?)'} — ${changes.join(' / ')}`,
      detail: { order_id: Number(id), changes, forced },
    });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardOrder(req, id);
  if (deny) return deny;
  const db = await getDb();
  const info = await db.execute({ sql: 'SELECT product_name, component, process_line FROM orders WHERE id = ?', args: [id] });
  const oi = info.rows[0] as Record<string, unknown> | undefined;
  await logAudit(req, {
    action: 'order_delete',
    line: String(oi?.process_line ?? ''),
    target: `주문 삭제: ${oi?.product_name ?? '(?)'}${oi?.component ? `(${oi.component})` : ''}`,
    detail: { order_id: Number(id) },
  });
  await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
  return NextResponse.json({ success: true });
}
