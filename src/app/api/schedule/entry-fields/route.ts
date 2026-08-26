import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { effectiveMinutes } from '@/lib/print';
import { sumDurations, parseParts, parsePartDurations } from '@/lib/parts';
import { guardEntry } from '@/lib/permits';

// 윤전 전용: 설비 배정 항목(schedule_entry)의 '자체 표시값'과 구성(파트)을 수정한다.
// 표시값(제품명·비고·수량)만 바꾸면 원본 주문은 건드리지 않는다(구역 독립 수정).
// 단, '구성(파트)명'을 바꾸면(예: 1~3 → 1~3 10) 이 설비 항목만 바뀌고 주문(orders.component)엔
// 옛 이름이 남아, 대기 계산(주문 구성 − 설비 구성)에서 옛 이름이 '유령 배정대기'로 다시 뜬다.
// → 이 항목의 옛 구성명을 새 구성명으로 주문에서도 교체해, 유령 대기/중복·오삭제를 막는다.
export async function POST(req: NextRequest) {
  const { entry_id, product_name, notes, quantity_sheets, duration_minutes, parts } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const srcRes = await db.execute({ sql: 'SELECT machine_id, print_mode, order_id, component_part FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcRes.rows[0] as unknown as { machine_id: number; print_mode: string; order_id: number; component_part: string | null } | undefined;
  if (!src) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const oldParts = parseParts(src.component_part || '');

  // 표시값(제품명·비고·수량) + entry_edited=1(제품명·수량 자체값) + entry_notes_edited=1(비고 자체값)
  let setSql = 'entry_product_name = ?, entry_notes = ?, entry_quantity = ?, entry_edited = 1, entry_notes_edited = 1';
  const args: (string | number)[] = [String(product_name ?? ''), String(notes ?? ''), Number(quantity_sheets) || 0];

  // 구성(파트) 목록이 오면 이 설비 항목의 구성·파트별 소요시간을 반영한다(추가/삭제 포함).
  const list = Array.isArray(parts)
    ? (parts as { name?: string; minutes?: number }[]).filter((p) => String(p?.name ?? '').trim())
    : [];
  let newParts: string[] = [];
  const newDurs: Record<string, number> = {};
  if (list.length > 0) {
    for (const p of list) newDurs[String(p.name).trim()] = Math.max(0, Math.round(Number(p.minutes) || 0));
    newParts = Object.keys(newDurs);
    const base = sumDurations(newDurs);
    setSql += ', component_part = ?, part_durations = ?, base_minutes = ?, duration_minutes = ?';
    args.push(newParts.join(', '), JSON.stringify(newDurs), base, effectiveMinutes(base, String(src.print_mode)));
  } else {
    // 구성을 비운(또는 원래 통째) 항목: 구성·파트별 소요시간을 확실히 비우고(예전 자동생성 '1대' 등 잔재 제거)
    // 전체 소요시간으로 갱신한다. component_part를 반드시 ''로 덮어써야 수정에서 구성을 지웠을 때 실제로 사라진다.
    setSql += ', component_part = ?, part_durations = ?';
    args.push('', '{}');
    const dur = Number(duration_minutes);
    if (Number.isFinite(dur) && dur > 0) {
      setSql += ', base_minutes = ?, duration_minutes = ?';
      args.push(dur, dur);
    }
  }
  args.push(entry_id);
  await db.execute({ sql: `UPDATE schedule_entries SET ${setSql} WHERE id = ?`, args });

  // 구성명이 실제로 바뀐 경우에만 주문의 구성을 동기화한다(이 항목의 옛 구성명 → 새 구성명).
  // 다른 설비 항목·배정대기 구성은 그대로 두어 구역 독립을 유지하고, 이 항목 구성만 교체한다.
  const sameSet = oldParts.length === newParts.length && oldParts.every((p) => newParts.includes(p));
  if (!sameSet && src.order_id != null) {
    const ordRes = await db.execute({ sql: 'SELECT component, part_durations FROM orders WHERE id = ?', args: [src.order_id] });
    const ord = ordRes.rows[0] as unknown as { component: string | null; part_durations: string | null } | undefined;
    if (ord) {
      const orderParts = parseParts(ord.component || '');
      const kept = orderParts.filter((p) => !oldParts.includes(p)); // 이 항목의 옛 구성 제거
      const finalParts = [...kept, ...newParts.filter((p) => !kept.includes(p))]; // 새 구성 추가(중복 방지)
      const opd = parsePartDurations(ord.part_durations);
      for (const p of oldParts) delete opd[p];
      for (const p of newParts) opd[p] = newDurs[p] ?? opd[p] ?? 0;
      await db.execute({ sql: 'UPDATE orders SET component = ?, part_durations = ? WHERE id = ?', args: [finalParts.join(', '), JSON.stringify(opd), src.order_id] });
    }
  }

  // 구성·소요시간이 바뀌었으니 그 설비의 완료시각을 다시 계산한다.
  await recalcMachine(Number(src.machine_id), todayLocal());

  return NextResponse.json({ success: true });
}
