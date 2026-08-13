import { NextRequest, NextResponse } from 'next/server';
import { todayLocal } from '@/lib/date';
import { getDb } from '@/lib/db';
import { guardMachine } from '@/lib/permits';
import { recalcMachine } from '@/lib/calc';
import { isValidShiftName } from '@/lib/shifts';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardMachine(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  await db.execute({
    sql: `UPDATE machines SET name = ?, description = ?, speed_sheets_per_hour = ?, setup_time_minutes = ?, capabilities = ?, work_start_hour = ?, work_end_hour = ?, works_saturday = ?, works_sunday = ?, is_active = ? WHERE id = ?`,
    args: [
      body.name,
      body.description || '',
      body.speed_sheets_per_hour,
      body.setup_time_minutes,
      JSON.stringify(body.capabilities || []),
      body.work_start_hour,
      body.work_end_hour,
      body.works_saturday ? 1 : 0,
      body.works_sunday ? 1 : 0,
      body.is_active ? 1 : 0,
      id,
    ],
  });

  return NextResponse.json({ success: true });
}

// 설비명만 변경 (다른 설정은 유지)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardMachine(req, id);
  if (deny) return deny;
  const body = await req.json();
  const db = await getDb();

  if (typeof body.name === 'string' && body.name.trim()) {
    await db.execute({ sql: 'UPDATE machines SET name = ? WHERE id = ?', args: [body.name.trim(), id] });
  }

  if (typeof body.memo === 'string') {
    await db.execute({ sql: 'UPDATE machines SET memo = ? WHERE id = ?', args: [body.memo, id] });
  }

  if (typeof body.extra_notes === 'string') {
    await db.execute({ sql: 'UPDATE machines SET extra_notes = ? WHERE id = ?', args: [body.extra_notes, id] });
  }

  // 근무 시작/종료 시각 변경 → 예상완료시간이 달라지므로 이 설비 일정을 재계산한다.
  let recalcNeeded = false;
  if (body.work_start_hour != null && Number.isFinite(Number(body.work_start_hour))) {
    await db.execute({ sql: 'UPDATE machines SET work_start_hour = ? WHERE id = ?', args: [Number(body.work_start_hour), id] });
    recalcNeeded = true;
  }
  if (body.work_end_hour != null && Number.isFinite(Number(body.work_end_hour))) {
    await db.execute({ sql: 'UPDATE machines SET work_end_hour = ? WHERE id = ?', args: [Number(body.work_end_hour), id] });
    recalcNeeded = true;
  }
  // 휴무 요일 변경 → 예상완료시간 재계산. 0~6 값만 허용(7요일 전체 휴무=전체 휴무 설비도 허용).
  if (Array.isArray(body.off_days)) {
    const off = Array.from(new Set(body.off_days.map(Number).filter((n: number) => n >= 0 && n <= 6)));
    await db.execute({ sql: 'UPDATE machines SET off_days = ? WHERE id = ?', args: [JSON.stringify(off), id] });
    recalcNeeded = true;
  }
  // 요일별 근무시간 오버라이드. { "1":[8,24], "6":[8,18] } 형태만 허용, 0~24 범위로 정제. 빈 객체면 오버라이드 해제('').
  if (body.day_hours != null && typeof body.day_hours === 'object' && !Array.isArray(body.day_hours)) {
    const clean: Record<string, [number, number]> = {};
    for (const [k, v] of Object.entries(body.day_hours as Record<string, unknown>)) {
      const d = Number(k);
      if (d >= 0 && d <= 6 && Array.isArray(v) && v.length === 2) {
        const s = Math.min(Math.max(Number(v[0]), 0), 24);
        const e = Math.min(Math.max(Number(v[1]), 0), 24);
        if (Number.isFinite(s) && Number.isFinite(e)) clean[d] = [s, e];
      }
    }
    await db.execute({ sql: 'UPDATE machines SET day_hours = ? WHERE id = ?', args: [Object.keys(clean).length ? JSON.stringify(clean) : '', id] });
    recalcNeeded = true;
  }
  // 요일별 근무체제. { "1": ["정상(주)","정상(야)"], ... } 형태만 허용(유효 체제명만).
  if (body.day_shifts != null && typeof body.day_shifts === 'object' && !Array.isArray(body.day_shifts)) {
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(body.day_shifts as Record<string, unknown>)) {
      const d = Number(k);
      if (d >= 0 && d <= 6 && Array.isArray(v)) {
        const names = v.filter((x): x is string => typeof x === 'string' && isValidShiftName(x));
        if (names.length) clean[d] = names;
      }
    }
    await db.execute({ sql: 'UPDATE machines SET day_shifts = ? WHERE id = ?', args: [Object.keys(clean).length ? JSON.stringify(clean) : '', id] });
    recalcNeeded = true;
  }
  // 일자별 예외 근무체제. { "2026-07-10": ["정상(주)"], "2026-08-15": [] } (빈 배열=그 날 휴무).
  // 지난 날짜도 수정·저장 가능(스케줄 계산엔 오늘 이후만 쓰이지만, 기록/보정 목적으로 그대로 보존).
  if (body.date_shifts != null && typeof body.date_shifts === 'object' && !Array.isArray(body.date_shifts)) {
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(body.date_shifts as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if (Array.isArray(v)) {
        clean[k] = v.filter((x): x is string => typeof x === 'string' && isValidShiftName(x)); // 빈 배열=휴무 유지
      }
    }
    await db.execute({ sql: 'UPDATE machines SET date_shifts = ? WHERE id = ?', args: [JSON.stringify(clean), id] });
    recalcNeeded = true;
  }
  if (recalcNeeded) {
    await recalcMachine(Number(id), todayLocal());
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deny = await guardMachine(req, id);
  if (deny) return deny;
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM machines WHERE id = ?', args: [id] });
  return NextResponse.json({ success: true });
}
