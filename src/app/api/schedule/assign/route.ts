import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcMachine } from '@/lib/calc';
import { parseParts, parsePartDurations, sumDurations, partTotals } from '@/lib/parts';
import { isDoubleSided, effectiveMinutes } from '@/lib/print';
import { guardOrder, guardMachine } from '@/lib/permits';

const DEFAULT_PART_MINUTES = 60;

export async function POST(req: NextRequest) {
  const { order_id, machine_id, start_time, component_part, alloc_minutes, before_entry_id, merge, merge_entry_id } = await req.json();
  // 주문과 대상 설비 모두 편집 권한이 있는 라인이어야 한다
  const denyO = await guardOrder(req, order_id);
  if (denyO) return denyO;
  const denyM = await guardMachine(req, machine_id);
  if (denyM) return denyM;
  const part = typeof component_part === 'string' ? component_part : '';
  const db = await getDb();

  const orderResult = await db.execute({ sql: 'SELECT quantity_sheets, duration_minutes, component, part_durations FROM orders WHERE id = ?', args: [order_id] });
  const order = orderResult.rows[0] as unknown as { quantity_sheets: number; duration_minutes: number; component: string; part_durations: string } | undefined;
  const totals = partTotals(order?.component ?? '', order?.part_durations, Number(order?.duration_minutes) || 0);

  const machineResult = await db.execute({
    sql: 'SELECT name, speed_sheets_per_hour, setup_time_minutes, process_line FROM machines WHERE id = ?',
    args: [machine_id],
  });
  const machine = machineResult.rows[0] as unknown as { name: string; speed_sheets_per_hour: number; setup_time_minutes: number; process_line: string } | undefined;
  // 양면설비면 기본 양면(소요시간 절반), 단면설비면 단면. 윤전은 양면 개념이 없어 항상 단면(입력 소요시간 그대로).
  const machineMode = machine && machine.process_line !== '윤전' && isDoubleSided(machine.name) ? 'double' : 'single';

  const incomingParts = parseParts(part);
  const today = new Date().toISOString().split('T')[0];

  // 이 드롭에서 배정할 시간(분). 지정값이 있으면 그 값, 없으면 파트 총량(또는 기본)을 사용.
  const alloc = Number(alloc_minutes);
  const hasAlloc = Number.isFinite(alloc) && alloc > 0;

  // merge=true일 때만 같은 주문의 기존 행에 합산(묶기). 아니면 항상 새 행을 만들어
  // 드롭한 위치에 독립적으로 둔다(같은 제품 구성을 따로 배치 가능).
  let existingId: number | null = null;
  if (merge === true && incomingParts.length > 0) {
    // merge_entry_id가 오면 그 특정 행에, 없으면 같은 주문의 기존 행 하나에 합친다.
    const mergeInto = merge_entry_id != null ? Number(merge_entry_id) : null;
    const exResult = mergeInto != null
      ? await db.execute({
          sql: 'SELECT id, component_part, part_durations, print_mode FROM schedule_entries WHERE id = ? AND order_id = ? AND machine_id = ?',
          args: [mergeInto, order_id, machine_id],
        })
      : await db.execute({
          sql: 'SELECT id, component_part, part_durations, print_mode FROM schedule_entries WHERE order_id = ? AND machine_id = ? LIMIT 1',
          args: [order_id, machine_id],
        });
    const exRow = exResult.rows[0] as unknown as { id: number; component_part: string; part_durations: string; print_mode: string } | undefined;
    if (exRow) {
      existingId = Number(exRow.id);
      const merged = parseParts(String(exRow.component_part));
      const durs = parsePartDurations(exRow.part_durations);
      for (const p of incomingParts) {
        if (!merged.includes(p)) merged.push(p);
        const add = hasAlloc ? alloc : (totals[p] ?? DEFAULT_PART_MINUTES);
        durs[p] = (Number(durs[p]) || 0) + add;
      }
      const mergedBase = sumDurations(durs);
      await db.execute({
        sql: 'UPDATE schedule_entries SET component_part = ?, part_durations = ?, base_minutes = ?, duration_minutes = ? WHERE id = ?',
        args: [merged.join(', '), JSON.stringify(durs), mergedBase, effectiveMinutes(mergedBase, exRow.print_mode), existingId],
      });
    }
  }

  let newEntryId: number | null = null;
  if (existingId === null) {
    let baseDuration = 60;
    const partDurations: Record<string, number> = {};
    if (incomingParts.length > 0) {
      for (const p of incomingParts) partDurations[p] = hasAlloc ? alloc : (totals[p] ?? DEFAULT_PART_MINUTES);
      baseDuration = sumDurations(partDurations);
    } else if (order && Number(order.duration_minutes) > 0) {
      baseDuration = Number(order.duration_minutes);
    } else if (order && machine) {
      const printMinutes = (Number(order.quantity_sheets) / Number(machine.speed_sheets_per_hour)) * 60;
      baseDuration = Math.ceil(printMinutes + Number(machine.setup_time_minutes));
    }
    // 양면 설비면 기본 양면(소요시간 절반), 단면 설비면 단면. 통째 작업도 동일하게 적용(이후 토글로 변경 가능).
    const mode = machineMode;

    const maxSeqResult = await db.execute({
      sql: 'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM schedule_entries WHERE machine_id = ?',
      args: [machine_id],
    });
    const maxSeq = Number((maxSeqResult.rows[0] as unknown as { max_seq: number }).max_seq);

    const insertResult = await db.execute({
      sql: 'INSERT INTO schedule_entries (order_id, machine_id, sequence, base_minutes, duration_minutes, component_part, part_durations, print_mode, scheduled_date, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [order_id, machine_id, maxSeq + 1, baseDuration, effectiveMinutes(baseDuration, mode), part, JSON.stringify(partDurations), mode, today, today + ' 08:00', today + ' 08:00'],
    });
    newEntryId = Number(insertResult.lastInsertRowid);
  }

  // 특정 행 위치에 끼워넣기: 새로 만든 행을 before_entry_id 앞으로 이동하고 순서를 다시 매긴다.
  if (newEntryId !== null && before_entry_id != null && Number(before_entry_id) !== newEntryId) {
    const ents = await db.execute({
      sql: 'SELECT id FROM schedule_entries WHERE machine_id = ? ORDER BY sequence ASC',
      args: [machine_id],
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

  // 완료 판정: 모든 파트가 (시간 기준) 충분히 배정됐는지. 시간이 0인 파트는 한 번이라도 배정되면 완료.
  const partNames = Object.keys(totals);
  const allEntries = await db.execute({
    sql: 'SELECT component_part, part_durations FROM schedule_entries WHERE order_id = ?',
    args: [order_id],
  });
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
  const newStatus = allAssigned ? 'scheduled' : 'pending';
  await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [newStatus, order_id] });

  await recalcMachine(machine_id, today, start_time);

  return NextResponse.json({ success: true });
}
