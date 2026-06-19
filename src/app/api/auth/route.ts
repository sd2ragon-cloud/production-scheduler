import { NextRequest, NextResponse } from 'next/server';
import { getAdminRole, setAdminCookie, clearAdminCookie } from '@/lib/auth-token';
import { hasRolePassword, rolePasswordStatus, setRolePassword, verifyRolePassword, validatePasswordPolicy } from '@/lib/auth';
import { isAdminRole } from '@/lib/factory-config';

// 현재 권한 상태. 클라이언트(AuthProvider)가 폴링.
//  - role     : 로그인된 역할(sheet|wireless) 또는 null
//  - passwords: 역할별 비밀번호 설정 여부 (UI 로그인/설정 분기용)
export async function GET(req: NextRequest) {
  return NextResponse.json({
    role: getAdminRole(req),
    passwords: await rolePasswordStatus(),
  });
}

// action: login | logout | setup(최초 비번 설정) | change(비번 변경). 모두 역할(role) 단위로 동작.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');

  if (action === 'logout') {
    const res = NextResponse.json({ ok: true });
    clearAdminCookie(res);
    return res;
  }

  // setup/login은 역할을 명시한다.
  const role = body.role;

  if (action === 'setup') {
    if (!isAdminRole(role)) return NextResponse.json({ error: '역할이 올바르지 않습니다.' }, { status: 400 });
    // 최초 1회: 그 역할 비밀번호가 아직 없을 때만 설정 가능(그 외엔 거부 → 탈취 방지).
    if (await hasRolePassword(role)) {
      return NextResponse.json({ error: '이미 비밀번호가 설정되어 있습니다.' }, { status: 400 });
    }
    const pw = String(body.password || '');
    const err = validatePasswordPolicy(pw);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    await setRolePassword(role, pw);
    const res = NextResponse.json({ ok: true, role });
    setAdminCookie(res, role);
    return res;
  }

  if (action === 'login') {
    if (!isAdminRole(role)) return NextResponse.json({ error: '역할이 올바르지 않습니다.' }, { status: 400 });
    const pw = String(body.password || '');
    if (!(await verifyRolePassword(role, pw))) {
      return NextResponse.json({ error: '비밀번호가 올바르지 않습니다.' }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true, role });
    setAdminCookie(res, role);
    return res;
  }

  if (action === 'change') {
    // 현재 로그인된 역할의 비밀번호만 변경할 수 있다.
    const current = getAdminRole(req);
    if (!current) return NextResponse.json({ error: '관리자만 변경할 수 있습니다.' }, { status: 403 });
    const cur = String(body.password || '');
    const next = String(body.newPassword || '');
    if (!(await verifyRolePassword(current, cur))) return NextResponse.json({ error: '현재 비밀번호가 올바르지 않습니다.' }, { status: 401 });
    const err = validatePasswordPolicy(next);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    if (await verifyRolePassword(current, next)) return NextResponse.json({ error: '새 비밀번호가 현재 비밀번호와 같습니다.' }, { status: 400 });
    await setRolePassword(current, next);
    return NextResponse.json({ ok: true, role: current });
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
