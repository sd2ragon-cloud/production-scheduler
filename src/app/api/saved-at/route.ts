import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardLine } from '@/lib/permits';

// 라인별 '마지막 저장(수정)' 시각을 settings에 보관해 여러 관리자가 함께 본다.
// GET: 현재 저장 시각 조회. POST: 관리자가 '저장' 누르면 서버 시각으로 기록.
const KEY = (line: string) => `saved_at_${line}`;

function stampNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function GET(req: NextRequest) {
  const line = req.nextUrl.searchParams.get('process_line') || '매엽';
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [KEY(line)] });
  const saved_at = r.rows[0] ? String((r.rows[0] as unknown as { value: string }).value) : '';
  return NextResponse.json({ saved_at });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const line = String(body.process_line || '매엽');
  const deny = guardLine(req, line);
  if (deny) return deny;
  const saved_at = stampNow();
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [KEY(line), saved_at],
  });
  return NextResponse.json({ saved_at });
}
