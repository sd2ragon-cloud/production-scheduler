import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, sumDurations, partTotals } from '@/lib/parts';
import { isDoubleSided, effectiveMinutes } from '@/lib/print';
import { guardEntry, guardMachine } from '@/lib/permits';

// 구성 분할이 없는 '통째' 배정 행(component_part="")을 다른 설비로 옮긴다.
// move_minutes(실제 소요시간 기준)가 행의 전체보다 작으면 그만큼만 분할 이동(원본은 나머지 유지),
// 같거나 크면(또는 0) 전체 이동. 설비→설비 분할 생산을 지원한다. (매엽/윤전/무선 공통)
export async function POST(req: NextRequest) {
  const { entry_id, target_machine_id, move_minutes, before_entry_id, source_start_time, target_start_time, merge, merge_entry_id } = await req.json();
  const denyE = await guardEntry(req, entry_id);
  if (denyE) return denyE;
  const denyM = await guardMachine(req, target_machine_id);
  if (denyM) return denyM;
  const db = await getDb();

  const srcResult = await db.execute({ sql: 'SELECT * FROM schedule_entries WHERE id = ?', args: [entry_id] });
  const src = srcResult.rows[0] as unknown as
    | { id: number; order_id: number; machine_id: number; sequence: number; base_minutes: number; duration_minutes: number; component_part: string; part_durations: string; print_mode: string }
    | undefined;
  if (!src) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const orderId = Number(src.order_id);
  const srcMachine = Number(src.machine_id);
  const targetMachine = Number(target_machine_id);
  const srcMode = src.print_mode || 'single';

  // 대상 설비 기본 인쇄 모드 (윤전은 양면 개념 없이 항상 단면 → 입력 소요시간 그대로)
  const tgtMachineResult = await db.execute({ sql: 'SELECT name, process_line FROM machines WHERE id = ?', args: [targetMachine] });
  const tgtMachine = tgtMachineResult.rows[0] as unknown as { name: string; process_line: string } | undefined;
  const tgtMachineName = tgtMachine?.name ?? '';
  const targetMode = tgtMachine && !['윤전', '제책'].includes(tgtMachine.process_line) && isDoubleSided(tgtMachineName) ? 'double' : 'single';
  // 같은 설비 안에서는 원래 모드 유지, 다른 설비로 가면 대상 설비 기본 모드를 따른다.
  const newRowMode = srcMachine === targetMachine ? srcMode : targetMode;

  const today = todayLocal();

  // 분할량 계산: 실제 소요시간(duration_minutes) 기준으로 받는다.
  // 구성이 있으면 파트별 시간을 같은 비율로 나누고, 없으면 base_minutes만 나눈다.
  const srcEff = Number(src.duration_minutes) || 0;
  const srcBase = Number(src.base_minutes) || 0;
  const srcDurs = parsePartDurations(src.part_durations);
  const partKeys = Object.keys(srcDurs);
  const hasParts = partKeys.length > 0;
  const reqMove = Number(move_minutes);
  // merge(분할된 제품 합치기)일 때는 항상 원본 전체를 대상 행에 합친다(부분 합치기 없음).
  const partial = merge !== true && srcEff > 0 && Number.isFinite(reqMove) && reqMove > 0 && reqMove < srcEff;

  let movedBase: number;
  let remainingBase: number;
  let movedDurs: Record<string, number>;
  let srcRemDurs: Record<string, number>;
  if (!partial) {
    // 전체 이동
    movedBase = srcBase; remainingBase = 0; movedDurs = srcDurs; srcRemDurs = {};
  } else if (hasParts) {
    const f = reqMove / srcEff;
    movedDurs = {}; srcRemDurs = {};
    for (const p of partKeys) {
      const m = Number(srcDurs[p]) || 0;
      const mv = Math.min(Math.max(Math.round(m * f), 0), m);
      movedDurs[p] = mv; srcRemDurs[p] = m - mv;
    }
    movedBase = sumDurations(movedDurs); remainingBase = sumDurations(srcRemDurs);
  } else {
    const f = reqMove / srcEff;
    movedBase = Math.max(1, Math.round(srcBase * f)); remainingBase = srcBase - movedBase;
    movedDurs = {}; srcRemDurs = {};
  }
  const fullMove = !partial || remainingBase <= 0 || movedBase <= 0;

  // 1) 원본 행 처리: 전체 이동이면 삭제(+순서 보정), 분할이면 남은 시간만큼 유지
  if (fullMove) {
    await db.execute({ sql: 'DELETE FROM schedule_entries WHERE id = ?', args: [Number(src.id)] });
    await db.execute({
      sql: 'UPDATE schedule_entries SET sequence = sequence - 1 WHERE machine_id = ? AND sequence > ?',
      args: [srcMachine, Number(src.sequence)],
    });
  } else {
    await db.execute({
      sql: 'UPDATE schedule_entries SET base_minutes = ?, duration_minutes = ?, part_durations = ? WHERE id = ?',
      args: [remainingBase, effectiveMinutes(remainingBase, srcMode), hasParts ? JSON.stringify(srcRemDurs) : (src.part_durations || '{}'), Number(src.id)],
    });
  }

  // 2) 대상 설비 처리. merge면 같은 주문의 기존 행에 합쳐(분할된 제품 합치기), 아니면 새 행 추가.
  const targetBase = fullMove ? srcBase : movedBase;
  const movedDursFinal = fullMove ? srcDurs : movedDurs;
  const targetDursJson = fullMove ? (src.part_durations || '{}') : (hasParts ? JSON.stringify(movedDurs) : '{}');

  const mergeInto = merge === true && merge_entry_id != null ? Number(merge_entry_id) : null;
  const exResult = mergeInto != null
    ? await db.execute({
        sql: 'SELECT id, component_part, part_durations, base_minutes, print_mode FROM schedule_entries WHERE id = ? AND order_id = ? AND machine_id = ? AND id != ?',
        args: [mergeInto, orderId, targetMachine, Number(src.id)],
      })
    : null;
  const ex = exResult?.rows[0] as unknown as { id: number; component_part: string; part_durations: string; base_minutes: number; print_mode: string } | undefined;

  let newEntryId: number | null = null;
  if (ex) {
    // 같은 주문 행에 합치기: 구성·시간 합산
    const exParts = parseParts(String(ex.component_part));
    for (const p of parseParts(String(src.component_part))) if (!exParts.includes(p)) exParts.push(p);
    const durs = parsePartDurations(ex.part_durations);
    for (const [p, m] of Object.entries(movedDursFinal)) durs[p] = (Number(durs[p]) || 0) + (Number(m) || 0);
    const mergedHasParts = Object.keys(durs).length > 0;
    const exBase = mergedHasParts ? sumDurations(durs) : (Number(ex.base_minutes) || 0) + targetBase;
    await db.execute({
      sql: 'UPDATE schedule_entries SET component_part = ?, part_durations = ?, base_minutes = ?, duration_minutes = ? WHERE id = ?',
      args: [exParts.join(', '), JSON.stringify(durs), exBase, effectiveMinutes(exBase, ex.print_mode), Number(ex.id)],
    });
  } else {
    const maxSeqResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM schedule_entries WHERE machine_id = ?',
      args: [targetMachine],
    });
    const maxSeq = Number((maxSeqResult.rows[0] as unknown as { max_seq: number }).max_seq);
    const insertResult = await db.execute({
      sql: 'INSERT INTO schedule_entries (order_id, machine_id, sequence, base_minutes, duration_minutes, component_part, part_durations, print_mode, scheduled_date, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [orderId, targetMachine, maxSeq + 1, targetBase, effectiveMinutes(targetBase, newRowMode), src.component_part || '', targetDursJson, newRowMode, today, today + ' 08:00', today + ' 08:00'],
    });
    newEntryId = Number(insertResult.lastInsertRowid);
  }

  // 드롭 위치(before_entry_id) 앞으로 끼워넣기 (새 행을 만든 경우만)
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
