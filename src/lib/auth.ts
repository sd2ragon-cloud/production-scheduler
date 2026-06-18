import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { getDb } from './db';

// 관리자 비밀번호 저장/검증. settings 테이블에 admin_pw = "salt:hash"(scrypt)로 보관.
// DB를 쓰므로 route handler(Node)에서만 사용한다. (proxy는 auth-token만 사용)

function hash(plain: string, salt: string): string {
  return scryptSync(plain, salt, 64).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function hasAdminPassword(): Promise<boolean> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: ['admin_pw'] });
  return r.rows.length > 0 && !!String((r.rows[0] as unknown as { value: string }).value);
}

export async function setAdminPassword(plain: string): Promise<void> {
  const salt = randomBytes(16).toString('hex');
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES ('admin_pw', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [`${salt}:${hash(plain, salt)}`],
  });
}

export async function verifyPassword(plain: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: ['admin_pw'] });
  if (r.rows.length === 0) return false;
  const stored = String((r.rows[0] as unknown as { value: string }).value);
  const [salt, h] = stored.split(':');
  if (!salt || !h) return false;
  return safeEqual(hash(plain, salt), h);
}
