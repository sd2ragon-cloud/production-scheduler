import { NextRequest, NextResponse } from 'next/server';
import { getDb } from './db';
import { getAdminRole } from './auth-token';
import { ROLE_LINES, ROLE_LABELS } from './factory-config';

// 라인별 편집 권한 강제 (서버측). 각 쓰기 라우트가 "대상의 공정 라인"을 구해 호출한다.
//  - 매엽·윤전 관리자(sheet)  : 매엽·윤전 라인만 편집
//  - 무선 관리자(wireless)    : 무선 라인만 편집
// 보기(GET)는 proxy에서 모두 통과시키므로 여기선 쓰기만 다룬다.
// 식사·휴게 시간 등 전 공정 공통 자원은 라인이 없으므로 이 가드를 쓰지 않는다(로그인만 요구).

// 편집 가능하면 null, 불가하면 적절한 에러 응답(401/403/404)을 반환한다.
function deny(req: NextRequest, line: string | null | undefined): NextResponse | null {
  const role = getAdminRole(req);
  if (!role) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  if (line == null || line === '') return NextResponse.json({ error: '대상을 찾을 수 없습니다.' }, { status: 404 });
  if (!ROLE_LINES[role].includes(line)) {
    return NextResponse.json(
      { error: `${ROLE_LABELS[role]}는 '${line}' 라인을 편집할 수 없습니다.` },
      { status: 403 },
    );
  }
  return null;
}

// 명시적 라인 값(예: 새로 만들 항목의 body.process_line)으로 검사
export function guardLine(req: NextRequest, line: string | null | undefined): NextResponse | null {
  return deny(req, line);
}

async function lineFrom(sql: string, id: number | string): Promise<string | null> {
  const db = await getDb();
  const r = await db.execute({ sql, args: [id] });
  if (r.rows.length === 0) return null;
  return String((r.rows[0] as Record<string, unknown>).process_line ?? '') || null;
}

export async function guardMachine(req: NextRequest, machineId: number | string): Promise<NextResponse | null> {
  return deny(req, await lineFrom('SELECT process_line FROM machines WHERE id = ?', machineId));
}

export async function guardOrder(req: NextRequest, orderId: number | string): Promise<NextResponse | null> {
  return deny(req, await lineFrom('SELECT process_line FROM orders WHERE id = ?', orderId));
}

export async function guardBucket(req: NextRequest, bucketId: number | string): Promise<NextResponse | null> {
  return deny(req, await lineFrom('SELECT process_line FROM buckets WHERE id = ?', bucketId));
}

// schedule_entries엔 process_line이 없으므로 주문으로 조인해 라인을 구한다.
export async function guardEntry(req: NextRequest, entryId: number | string): Promise<NextResponse | null> {
  return deny(req, await lineFrom(
    'SELECT o.process_line AS process_line FROM schedule_entries se JOIN orders o ON se.order_id = o.id WHERE se.id = ?',
    entryId,
  ));
}

// 여러 id가 모두 편집 가능한 라인인지 (reorder류). 하나라도 불가하면 그 응답을 반환.
export async function guardMachineIds(req: NextRequest, ids: (number | string)[]): Promise<NextResponse | null> {
  for (const id of ids) { const d = await guardMachine(req, id); if (d) return d; }
  return null;
}

export async function guardBucketIds(req: NextRequest, ids: (number | string)[]): Promise<NextResponse | null> {
  for (const id of ids) { const d = await guardBucket(req, id); if (d) return d; }
  return null;
}
