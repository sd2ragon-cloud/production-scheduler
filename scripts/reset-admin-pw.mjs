// 관리자 비밀번호 초기화 도구 (최종 관리자가 운영 노트북에서 직접 실행).
// 지정한 역할의 저장된 비밀번호 해시를 지워, 앱에서 다시 '최초 비밀번호 설정' 화면이 뜨도록 한다.
// 그 다음 해당 탭에서 본인이 새 비밀번호를 정하면 된다. (비밀번호는 해시라 평문 복구는 불가능)
//
// 사용법 (production-scheduler 폴더에서):
//   node scripts/reset-admin-pw.mjs wireless   ← 제책 관리자
//   node scripts/reset-admin-pw.mjs sheet       ← 매엽·윤전 관리자
//   node scripts/reset-admin-pw.mjs all          ← 둘 다
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

// 앱과 같은 DB를 가리키도록 .env.local / .env 의 TURSO_* 값을 직접 읽어 채운다.
for (const f of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*(TURSO_DATABASE_URL|TURSO_AUTH_TOKEN)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 파일 없음 → 무시 */ }
}

const KEYS = { sheet: 'admin_pw_sheet', wireless: 'admin_pw_wireless' };
const arg = (process.argv[2] || '').toLowerCase();
const roles = arg === 'all' ? ['sheet', 'wireless'] : (KEYS[arg] ? [arg] : null);
if (!roles) {
  console.error('사용법: node scripts/reset-admin-pw.mjs <sheet|wireless|all>');
  console.error('  sheet   = 매엽·윤전 관리자');
  console.error('  wireless= 제책 관리자');
  process.exit(1);
}

const url = process.env.TURSO_DATABASE_URL || 'file:data/production.db';
const authToken = process.env.TURSO_AUTH_TOKEN;
const db = createClient(authToken ? { url, authToken } : { url });

console.log(`대상 DB: ${url}`);
for (const r of roles) {
  await db.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [KEYS[r]] });
  console.log(`초기화됨: ${r} 관리자 (${KEYS[r]})`);
}
console.log('완료 — 앱에서 해당 탭을 열면 새 비밀번호를 설정하라고 나옵니다.');
