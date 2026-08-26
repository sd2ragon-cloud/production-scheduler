import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardEntry } from '@/lib/permits';

// 설비 배정 항목의 '비고'만 그 항목 자체 값으로 저장한다(매엽·제책 등).
// entry_notes_edited=1 로 표시해, 같은 주문의 다른 배정(1차 배정·대기·다른 설비)의 비고와 분리한다.
// (제품명·수량 오버라이드용 entry_edited 와는 별개 — 비고만 항목별로 관리)
// 소요시간/일정과 무관하므로 재계산은 하지 않는다.
export async function POST(req: NextRequest) {
  const { entry_id, notes } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE schedule_entries SET entry_notes = ?, entry_notes_edited = 1 WHERE id = ?',
    args: [String(notes ?? ''), Number(entry_id)],
  });
  return NextResponse.json({ success: true });
}
