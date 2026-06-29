import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardEntry } from '@/lib/permits';

// 배정 행의 표시 색상(mark_color)을 설정한다. 관리자가 #번호를 클릭해 칠하는 표시로,
// DB에 저장돼 여러 관리자가 동일하게 본다. 소요시간/일정과 무관하므로 재계산은 하지 않는다.
const ALLOWED = new Set(['', 'amber']);

export async function POST(req: NextRequest) {
  const { entry_id, color } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const c = ALLOWED.has(color) ? color : '';
  const db = await getDb();
  await db.execute({ sql: 'UPDATE schedule_entries SET mark_color = ? WHERE id = ?', args: [c, Number(entry_id)] });
  return NextResponse.json({ success: true });
}
