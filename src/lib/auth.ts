import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { getDb } from './db';
import { type AdminRole } from './factory-config';

// 관리자 비밀번호 저장/검증. settings 테이블에 역할별로 admin_pw_<role> = "salt:hash"(scrypt)로 보관.
// DB를 쓰므로 route handler(Node)에서만 사용한다. (proxy는 auth-token만 사용)

// 역할 → settings 키. 기존 단일 admin_pw는 db.ts 마이그레이션에서 admin_pw_sheet로 이관된다.
const PW_KEY: Record<AdminRole, string> = {
  sheet: 'admin_pw_sheet',
  wireless: 'admin_pw_wireless',
};

function hash(plain: string, salt: string): string {
  return scryptSync(plain, salt, 64).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// 관리자 비밀번호 정책(설정·변경 공용). 통과하면 null, 위반하면 사용자에게 보일 한국어 사유.
// 외부(터널)로 노출되므로 추측·무차별 대입을 어렵게 하는 최소 강도를 강제한다.
// 이미 저장된 비밀번호는 해시로만 보관되어 이 검사를 거치지 않는다(새 설정·변경에만 적용).
const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', 'password', 'password1',
  'qwerty123', 'qwertyui', 'admin123', 'iloveyou', 'abcd1234', 'asdf1234',
]);

function isSequential(pw: string): boolean {
  // 전부 +1씩(오름차순) 또는 -1씩(내림차순) 이어지는지: 12345678, 87654321, abcdefgh 등.
  let asc = true;
  let desc = true;
  for (let i = 1; i < pw.length; i++) {
    const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

export function validatePasswordPolicy(plain: string): string | null {
  const pw = String(plain ?? '');
  if (pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (pw.length > 128) return '비밀번호가 너무 깁니다 (128자 이하).';
  if (/\s/.test(pw)) return '비밀번호에 공백은 사용할 수 없습니다.';
  if (/^(.)\1+$/.test(pw)) return '같은 문자만 반복해서 설정할 수 없습니다.';
  if (isSequential(pw)) return '연속된 숫자·문자(예: 12345678)만으로는 설정할 수 없습니다.';
  if (WEAK_PASSWORDS.has(pw.toLowerCase())) return '너무 흔한 비밀번호입니다. 다른 비밀번호를 사용하세요.';
  return null;
}

// 해당 역할의 비밀번호가 설정돼 있는지
export async function hasRolePassword(role: AdminRole): Promise<boolean> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [PW_KEY[role]] });
  return r.rows.length > 0 && !!String((r.rows[0] as unknown as { value: string }).value);
}

// 모든 역할의 비밀번호 설정 여부 맵 (UI에서 로그인/설정 분기에 사용)
export async function rolePasswordStatus(): Promise<Record<AdminRole, boolean>> {
  return {
    sheet: await hasRolePassword('sheet'),
    wireless: await hasRolePassword('wireless'),
  };
}

export async function setRolePassword(role: AdminRole, plain: string): Promise<void> {
  const salt = randomBytes(16).toString('hex');
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [PW_KEY[role], `${salt}:${hash(plain, salt)}`],
  });
}

export async function verifyRolePassword(role: AdminRole, plain: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [PW_KEY[role]] });
  if (r.rows.length === 0) return false;
  const stored = String((r.rows[0] as unknown as { value: string }).value);
  const [salt, h] = stored.split(':');
  if (!salt || !h) return false;
  return safeEqual(hash(plain, salt), h);
}
