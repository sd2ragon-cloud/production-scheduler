import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { effectiveMinutes } from '@/lib/print';
import { sumDurations } from '@/lib/parts';
import { guardEntry } from '@/lib/permits';

// 윤전 전용: 설비 배정 항목(schedule_entry)의 '자체 표시값'과 구성(파트)을 수정한다.
// 원본 주문(orders)은 건드리지 않으므로 1차 배정·배정 대기(같은 주문)는 그대로 유지된다(구역 독립 수정).
// parts가 오면 그 설비 항목의 구성·파트별 소요시간을 그대로 반영(구성 추가/삭제 포함)한다.
export async function POST(req: NextRequest) {
  const { entry_id, product_name, notes, quantity_sheets, duration_minutes, parts } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();

  const srcRes = await db.execute({ sql: 'SELECT machine_id, print_mode FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcRes.rows[0] as unknown as { machine_id: number; print_mode: string } | undefined;
  if (!src) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // 표시값(제품명·비고·수량) + entry_edited=1(이 항목은 주문값 대신 자체값 사용)
  let setSql = 'entry_product_name = ?, entry_notes = ?, entry_quantity = ?, entry_edited = 1';
  const args: (string | number)[] = [String(product_name ?? ''), String(notes ?? ''), Number(quantity_sheets) || 0];

  // 구성(파트) 목록이 오면 이 설비 항목의 구성·파트별 소요시간을 반영한다(추가/삭제 포함).
  const list = Array.isArray(parts)
    ? (parts as { name?: string; minutes?: number }[]).filter((p) => String(p?.name ?? '').trim())
    : [];
  if (list.length > 0) {
    const durs: Record<string, number> = {};
    for (const p of list) durs[String(p.name).trim()] = Math.max(0, Math.round(Number(p.minutes) || 0));
    const names = Object.keys(durs);
    const base = sumDurations(durs);
    setSql += ', component_part = ?, part_durations = ?, base_minutes = ?, duration_minutes = ?';
    args.push(names.join(', '), JSON.stringify(durs), base, effectiveMinutes(base, String(src.print_mode)));
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

  // 구성·소요시간이 바뀌었으니 그 설비의 완료시각을 다시 계산한다.
  await recalcMachine(Number(src.machine_id), todayLocal());

  return NextResponse.json({ success: true });
}
