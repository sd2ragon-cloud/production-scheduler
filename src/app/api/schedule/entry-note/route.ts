import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardEntry } from '@/lib/permits';

// 배정 행의 '완료책명'(done_book) 자유 메모를 설정한다. 화면 전용이며 소요시간/일정과 무관하므로 재계산은 하지 않는다.
// 쓰기(POST)는 proxy에서 관리자 쿠키가 없으면 막히므로, 편집은 관리자만 가능하다(보기는 조회로 누구나).
export async function POST(req: NextRequest) {
  const { entry_id, done_book } = await req.json();
  const deny = await guardEntry(req, entry_id);
  if (deny) return deny;
  const text = typeof done_book === 'string' ? done_book.slice(0, 2000) : '';
  const db = await getDb();
  await db.execute({ sql: 'UPDATE schedule_entries SET done_book = ? WHERE id = ?', args: [text, Number(entry_id)] });
  return NextResponse.json({ success: true });
}
