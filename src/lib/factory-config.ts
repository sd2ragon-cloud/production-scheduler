export const PROCESS_LINES = ['매엽', '윤전', '무선'];

export const DEFAULT_PROCESS = '매엽';

// 관리자 역할(모드). 전사 총괄 없이 두 파트장이 각자 영역을 관리한다.
//  - sheet   : 매엽·윤전 관리자
//  - wireless: 무선 관리자
// 의존성 없는 설정 파일이라 proxy(미들웨어)·route·클라이언트 어디서든 import 가능하다.
export const ADMIN_ROLES = ['sheet', 'wireless'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ROLE_LABELS: Record<AdminRole, string> = {
  sheet: '매엽·윤전 관리자',
  wireless: '무선 관리자',
};

// 역할이 '편집'할 수 있는 공정 라인. (보기는 전체 가능 — 편집만 제한)
// 라인별 쓰기 권한 강제는 다음 단계에서 이 매핑을 사용한다.
export const ROLE_LINES: Record<AdminRole, string[]> = {
  sheet: ['매엽', '윤전'],
  wireless: ['무선'],
};

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

// 역할이 해당 공정 라인을 '편집'할 수 있는지. role이 null(보기 전용)이면 false.
export function roleCanEditLine(role: AdminRole | null | undefined, line: string): boolean {
  return !!role && ROLE_LINES[role].includes(line);
}
