import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequest, setAdminCookie, clearAdminCookie } from '@/lib/auth-token';
import { hasAdminPassword, setAdminPassword, verifyPassword } from '@/lib/auth';

// 현재 권한 상태. 클라이언트(AuthProvider)가 폴링.
export async function GET(req: NextRequest) {
  return NextResponse.json({
    isAdmin: isAdminRequest(req),
    hasPassword: await hasAdminPassword(),
  });
}

// action: login | logout | setup(최초 비번 설정) | change(비번 변경)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');

  if (action === 'logout') {
    const res = NextResponse.json({ ok: true });
    clearAdminCookie(res);
    return res;
  }

  if (action === 'setup') {
    // 최초 1회: 비밀번호가 아직 없을 때만 설정 가능(그 외엔 거부 → 탈취 방지).
    if (await hasAdminPassword()) {
      return NextResponse.json({ error: '이미 비밀번호가 설정되어 있습니다.' }, { status: 400 });
    }
    const pw = String(body.password || '');
    if (pw.length < 4) return NextResponse.json({ error: '비밀번호는 4자 이상이어야 합니다.' }, { status: 400 });
    await setAdminPassword(pw);
    const res = NextResponse.json({ ok: true });
    setAdminCookie(res);
    return res;
  }

  if (action === 'login') {
    const pw = String(body.password || '');
    if (!(await verifyPassword(pw))) {
      return NextResponse.json({ error: '비밀번호가 올바르지 않습니다.' }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    setAdminCookie(res);
    return res;
  }

  if (action === 'change') {
    if (!isAdminRequest(req)) return NextResponse.json({ error: '관리자만 변경할 수 있습니다.' }, { status: 403 });
    const cur = String(body.password || '');
    const next = String(body.newPassword || '');
    if (!(await verifyPassword(cur))) return NextResponse.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, { status: 401 });
    if (next.length < 4) return NextResponse.json({ error: '새 비밀번호는 4자 이상이어야 합니다.' }, { status: 400 });
    await setAdminPassword(next);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
