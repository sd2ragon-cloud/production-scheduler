import type { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ADMIN_ROLES, isAdminRole, type AdminRole } from './factory-config';

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

// 역할별 토큰 = HMAC(secret, "role-v1:<role>"). 비밀키를 아는 서버만 재현 가능.
function tokenFor(role: string): string {
  return createHmac('sha256', getSecret()).update(`role-v1:${role}`).digest('hex');
}

// 쿠키에 담는 값 = "<role>.<token>". 역할이 평문으로 들어가지만 토큰 서명으로 위변조를 막는다.
function cookieValueFor(role: AdminRole): string {
  return `${role}.${tokenFor(role)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// 요청 쿠키만으로 로그인된 관리자 역할을 판정 (proxy/route 공용). 없거나 서명이 안 맞으면 null.
export function getAdminRole(req: NextRequest): AdminRole | null {
  const c = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!c) return null;
  const dot = c.indexOf('.');
  if (dot < 0) return null;
  const role = c.slice(0, dot);
  const sig = c.slice(dot + 1);
  if (!isAdminRole(role)) return null;
  return safeEqual(sig, tokenFor(role)) ? role : null;
}

// 어느 역할이든 로그인되어 있으면 true (쓰기 허용 1차 게이트). 라인별 세부 권한은 각 라우트에서 처리.
export function isAdminRequest(req: NextRequest): boolean {
  return getAdminRole(req) !== null;
}

export function setAdminCookie(res: NextResponse, role: AdminRole) {
  res.cookies.set(ADMIN_COOKIE, cookieValueFor(role), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30일
  });
}

export function clearAdminCookie(res: NextResponse) {
  res.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

export { ADMIN_ROLES };
export type { AdminRole };
