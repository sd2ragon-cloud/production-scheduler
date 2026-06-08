import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, sumDurations, partTotals } from '@/lib/parts';
import { isDoubleSided, effectiveMinutes } from '@/lib/print';

const DEFAULT_PART_MINUTES = 60;

// 병합된 행에서 특정 파트 하나만 다른 설비로 분리/이동한다.
export async function POST(req: NextRequest) {
  const { entry_id, part, target_machine_id, source_start_time, target_start_time, move_minutes, before_entry_id } = await req.json();
  const partStr = typeof part === 'string' ? part.trim() : '';
  const db = await getDb();

  if (!partStr) {
    return NextResponse.json({ error: 'no part' }, { status: 400 });
  }

  const srcResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcResult.rows[0] as unknown as
    | { id: number; order_id: number; machine_id: number; sequence: number; duration_minutes: number; component_part: string; part_durations: string; print_mode: string }
    | undefined;
  if (!src) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const orderId = Number(src.order_id);
  const srcMachine = Number(src.machine_id);
  const targetMachine = Number(target_machine_id);
  const srcMode = src.print_mode || 'single';
  // 대상 설비의 기본 인쇄 모드
  const tgtMachineResult = await db.execute({ sql: 'SELECT name FROM machines WHERE id = ?', args: [targetMachine] });
  const tgtMachineName = (tgtMachineResult.rows[0] as unknown as { name: string } | undefined)?.name ?? '';
  const targetMode = isDoubleSided(tgtMachineName) ? 'double' : 'single';

  // 같은 설비로 떨어뜨리면 변화 없음
  if (srcMachine === targetMachine) {
    return NextResponse.json({ success: true });
  }

  const srcParts = parseParts(String(src.component_part));
  if (!srcParts.includes(partStr)) {
    return NextResponse.json({ error: 'part not in entry' }, { status: 400 });
  }

  const today = new Date().toISOString().split('T')[0];
  const remaining = srcParts.filter((p) => p !== partStr);
  const srcDurations = parsePartDurations(src.part_durations);
  const srcAlloc = Number(srcDurations[partStr]) || DEFAULT_PART_MINUTES;

  // 옮길 시간(분). 지정값이 원본 배정량보다 작으면 부분 이동, 같거나 크면 전체 이동.
  const reqMove = Number(move_minutes);
  const moveMin = Number.isFinite(reqMove) && reqMove > 0 && reqMove < srcAlloc ? reqMove : srcAlloc;
  const fullMove = moveMin >= srcAlloc;

  // 1) 원본 행 처리
  if (fullMove) {
    // 파트 전체 이동: 원본에서 파트 제거 (남은 파트 없으면 행 삭제 + 순서 보정)
    if (remaining.length === 0) {
      await db.execute({ sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [Number(src.id)] });
      await db.execute({
        sql: 'UPDATE schedule_entries SET sequence = sequence - 1 WHERE machine_id = ? AND sequence > ?',
        args: [srcMachine, Number(src.sequence)],
      });
    } else {
      delete srcDurations[partStr];
      await db.execute({
        sql: 'UPDATE schedule_entries SET component_part = ?, part_durations = ?, duration_minutes = ? WHERE id = ?',
        args: [remaining.join(', '), JSON.stringify(srcDurations), effectiveMinutes(sumDurations(srcDurations), srcMode), Number(src.id)],
      });
    }
  } else {
    // 부분 이동: 원본에는 남은 시간만큼 유지 (파트는 그대로 둠)
    srcDurations[partStr] = srcAlloc - moveMin;
    await db.execute({
      sql: 'UPDATE schedule_entries SET part_durations = ?, duration_minutes = ? WHERE id = ?',
      args: [JSON.stringify(srcDurations), effectiveMinutes(sumDurations(srcDurations), srcMode), Number(src.id)],
    });
  }

  // 2) 대상 설비에 파트 추가 (같은 주문 행이 있으면 병합, 없으면 신규) — 파트의 소요시간도 함께 이동
  const exResult = await db.execute({
    sql: 'SELECT id, component_part, part_durations, print_mode FROM schedule_entries WHERE order_id = ? AND machine_id = ? LIMIT 1',
    args: [orderId, targetMachine],
  });
  const ex = exResult.rows[0] as unknown as { id: number; component_part: string; part_durations: string; print_mode: string } | undefined;
  let newEntryId: number | null = null;
  if (ex) {
    const merged = parseParts(String(ex.component_part));
    const durs = parsePartDurations(ex.part_durations);
    if (!merged.includes(partStr)) merged.push(partStr);
    durs[partStr] = (Number(durs[partStr]) || 0) + moveMin;
    await db.execute({
      sql: 'UPDATE schedule_entries SET component_part = ?, part_durations = ?, duration_minutes = ? WHERE id = ?',
      args: [merged.join(', '), JSON.stringify(durs), effectiveMinutes(sumDurations(durs), ex.print_mode), Number(ex.id)],
    });
  } else {
    const durs = { [partStr]: moveMin };
    const maxSeqResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM schedule_entries WHERE machine_id = ?',
      args: [targetMachine],
    });
    const maxSeq = Number((maxSeqResult.rows[0] as unknown as { max_seq: number }).max_seq);
    const insertResult = await db.execute({
      sql: 'INSERT INTO schedule_entries (order_id, machine_id, sequence, duration_minutes, component_part, part_durations, print_mode, scheduled_date, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [orderId, targetMachine, maxSeq + 1, effectiveMinutes(moveMin, targetMode), partStr, JSON.stringify(durs), targetMode, today, today + ' 08:00', today + ' 08:00'],
    });
    newEntryId = Number(insertResult.lastInsertRowid);
  }

  // 특정 행 위치에 끼워넣기: 새로 만든 행을 before_entry_id 앞으로 이동하고 순서를 다시 매긴다.
  if (newEntryId !== null && before_entry_id != null && Number(before_entry_id) !== newEntryId) {
    const ents = await db.execute({
      sql: 'SELECT id FROM schedule_entries WHERE machine_id = ? ORDER BY sequence ASC',
      args: [targetMachine],
    });
    const ids = (ents.rows as unknown as { id: number }[]).map((r) => Number(r.id)).filter((id) => id !== newEntryId);
    const idx = ids.indexOf(Number(before_entry_id));
    if (idx >= 0) ids.splice(idx, 0, newEntryId);
    else ids.push(newEntryId);
    await db.batch(
      ids.map((id, i) => ({ sql: 'UPDATE schedule_entries SET sequence = ? WHERE id = ?', args: [i + 1, id] })),
      'write',
    );
  }

  // 3) 주문 상태 재계산 (시간 기준 완료 판정)
  const orderResult = await db.execute({ sql: 'SELECT component, duration_minutes, part_durations FROM orders WHERE id = ?', args: [orderId] });
  const order = orderResult.rows[0] as unknown as { component: string; duration_minutes: number; part_durations: string } | undefined;
  const totals = partTotals(order?.component ?? '', order?.part_durations, Number(order?.duration_minutes) || 0);
  const partNames = Object.keys(totals);
  const allEntries = await db.execute({ sql: 'SELECT component_part, part_durations FROM schedule_entries WHERE order_id = ?', args: [orderId] });
  let allAssigned: boolean;
  if (partNames.length === 0) {
    allAssigned = allEntries.rows.length >= 1;
  } else {
    const allocated: Record<string, number> = {};
    const present = new Set<string>();
    for (const r of allEntries.rows as unknown as { component_part: string; part_durations: string }[]) {
      const durs = parsePartDurations(r.part_durations);
      for (const [p, m] of Object.entries(durs)) allocated[p] = (allocated[p] || 0) + (Number(m) || 0);
      parseParts(String(r.component_part)).forEach((p) => present.add(p));
    }
    allAssigned = partNames.every((p) => {
      const t = totals[p];
      return t > 0 ? (allocated[p] || 0) >= t : present.has(p);
    });
  }
  await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [allAssigned ? 'scheduled' : 'pending', orderId] });

  // 4) 두 설비 모두 일정 재계산
  await recalcMachine(srcMachine, today, typeof source_start_time === 'string' ? source_start_time : undefined);
  await recalcMachine(targetMachine, today, typeof target_start_time === 'string' ? target_start_time : undefined);

  return NextResponse.json({ success: true });
}
