import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { recalcAllMachines } from '@/lib/calc';

// 전 설비 예상완료시간 일괄 재계산. 계산 규칙(예: 근무체제=CAPA)이 바뀌었을 때,
// 기존에 잡혀 있던 일정들을 현재 로직으로 다시 계산해 반영하기 위해 수동 트리거한다.
export async function POST() {
  const db = await getDb();
  const cnt = (await db.execute('SELECT COUNT(*) as c FROM machines WHERE is_active = 1')).rows[0] as unknown as { c: number };
  await recalcAllMachines();
  return NextResponse.json({ success: true, machines: Number(cnt.c) });
}
