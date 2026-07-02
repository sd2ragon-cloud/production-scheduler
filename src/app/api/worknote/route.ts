import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

// 라인별 '완료책명' 메모장(자유 텍스트). settings 테이블에 key='worknote:{라인}' 로 저장한다.
// 화면 전용이며 소요시간/일정과 무관. 조회(GET)는 누구나, 저장(POST)은 해당 라인 관리자만(proxy가 쓰기 차단).
export const dynamic = 'force-dynamic';

function keyFor(line: string): string {
  return `worknote:${line || '매엽'}`;
}

export async function GET(req: NextRequest) {
  const line = req.nextUrl.searchParams.get('process_line') || '매엽';
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [keyFor(line)] });
  const note = r.rows.length ? String((r.rows[0] as unknown as { value: string }).value) : '';
  return NextResponse.json({ note });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const line = String(body.process_line || '매엽');
  const deny = guardLine(req, line);
  if (deny) return deny;
  const note = typeof body.note === 'string' ? body.note.slice(0, 20000) : '';
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [keyFor(line), note],
  });
  return NextResponse.json({ success: true });
}
