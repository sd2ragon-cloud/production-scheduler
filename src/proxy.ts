import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminRole } from '@/lib/auth-token';

// 서버측 권한 차단(이 Next 16에서는 middleware가 proxy로 바뀜, 기본 Node 런타임).
// 규칙: 조회(GET/HEAD/OPTIONS)와 로그인 엔드포인트(/api/auth)는 누구나. 그 외 모든 쓰기
// (POST/PUT/PATCH/DELETE)는 관리자 쿠키가 있어야 통과. 없으면 403 → 보기 전용 사용자는
// 화면에서 버튼을 우회해 직접 호출해도 변경 불가.
export const config = {
  matcher: '/api/:path*',
};

export function proxy(req: NextRequest) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return NextResponse.next();
  }
  // 로그인/로그아웃/최초설정은 비관리자도 호출해야 하므로 통과(라우트가 자체 검증).
  if (req.nextUrl.pathname === '/api/auth') {
    return NextResponse.next();
  }
  const role = getAdminRole(req);
  // CTP 담당자는 판 출력 체크(/api/plates)만 쓸 수 있다(식사시간 등 라인 없는 공통 설정도 변경 불가).
  if (role === 'ctp') {
    if (req.nextUrl.pathname === '/api/plates') return NextResponse.next();
    return NextResponse.json({ error: 'CTP 담당자는 판 출력 체크만 할 수 있습니다.' }, { status: 403 });
  }
  if (role) {
    return NextResponse.next();
  }
  return NextResponse.json({ error: '관리자만 변경할 수 있습니다. 우측 상단에서 관리자 로그인하세요.' }, { status: 403 });
}
