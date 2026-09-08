import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isAdminRequest } from '@/lib/auth-token';

// 삭제 이력(감사 로그) 조회. 관리자만. ?line=매엽&limit=100
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const line = sp.get('line') || '';
  const n = Number(sp.get('limit'));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;
  const db = await getDb();
  const rows = line
    ? (await db.execute({ sql: 'SELECT * FROM audit_log WHERE process_line = ? ORDER BY id DESC LIMIT ?', args: [line, limit] })).rows
    : (await db.execute({ sql: 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', args: [limit] })).rows;
  return NextResponse.json(rows);
}
