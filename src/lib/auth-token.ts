import type { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// 관리자 쿠키 검증 전용 모듈. **DB를 import하지 않는다** — proxy.ts(Node 런타임)에서
// libsql 같은 무거운 모듈 없이 파일+crypto만으로 쿠키를 검증할 수 있게 하기 위함.
// 쿠키 서명 비밀키는 data/.auth-secret 파일에 보관(.gitignore, 노트북 밖으로 안 나감, 배포에도 안 지워짐).

export const ADMIN_COOKIE = 'ps_admin';

const SECRET_PATH = join(process.cwd(), 'data', '.auth-secret');
let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  try {
    const s = readFileSync(SECRET_PATH, 'utf8').trim();
    if (s) { cachedSecret = s; return s; }
  } catch { /* 파일 없음 → 아래에서 생성 */ }
  const s = randomBytes(32).toString('hex');
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(SECRET_PATH, s, 'utf8');
  } catch { /* 쓰기 실패해도 메모리 캐시로는 동작(재시작 시 재발급) */ }
  cachedSecret = s;
  return s;
}

// 쿠키에 담는 관리자 토큰 = HMAC(secret, "admin-v1"). 비밀키를 아는 서버만 재현 가능.
export function adminToken(): string {
  return createHmac('sha256', getSecret()).update('admin-v1').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// 요청의 쿠키만으로 관리자 여부 판정 (proxy/route 공용).
export function isAdminRequest(req: NextRequest): boolean {
  const c = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!c) return false;
  return safeEqual(c, adminToken());
}

export function setAdminCookie(res: NextResponse) {
  res.cookies.set(ADMIN_COOKIE, adminToken(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30일
  });
}

export function clearAdminCookie(res: NextResponse) {
  res.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}
