import { NextRequest } from 'next/server';
import { getDb } from './db';
import { getAdminRole } from './auth-token';

// 삭제 이력(감사 로그). 개인 계정이 없는 구조라 '누가'를 대신할 단서를 함께 남긴다:
//  · device      : 브라우저에 심어둔 고유 PC 식별자(쿠키 ps_device) — IP가 바뀌어도 유지됨
//  · device_name : 사용자가 직접 지정한 PC 이름(쿠키 ps_device_name) — 있으면 '누가'가 바로 보임
//  · ip / via    : 접속 IP(프록시 헤더가 있을 때)와 접속 경로(사내망 IP인지 외부 ts.net인지)
// 기록 실패가 본 기능(삭제)을 막으면 안 되므로 절대 throw 하지 않는다(best-effort).
export type AuditAction =
  | 'order_delete'      // 주문(제품) 자체 삭제
  | 'entry_delete'      // 설비 배정 삭제
  | 'unassign'          // 배정 취소(대기로 되돌림)
  | 'unassign_part'     // 구성 일부 배정 취소
  | 'complete'          // 완료 처리로 제거
  | 'undo_restore';     // 되돌리기(Undo)로 스냅샷 이후 항목 제거

export interface AuditInput {
  action: AuditAction;
  line?: string | null;   // 공정 라인(매엽/윤전/제책)
  target: string;         // 사람이 읽는 대상 설명 (예: "검정)초)영어3 (부록1 2대) @MB10")
  detail?: unknown;       // 부가 정보(JSON으로 저장): order_id, entry_id 등
}

function firstIp(v: string | null): string {
  if (!v) return '';
  return v.split(',')[0].trim();
}

export async function logAudit(req: NextRequest, input: AuditInput): Promise<void> {
  try {
    const h = req.headers;
    const ip = firstIp(h.get('x-forwarded-for')) || h.get('x-real-ip') || '';
    const via = (h.get('host') || '').toLowerCase();
    const device = req.cookies.get('ps_device')?.value || '';
    const deviceName = decodeURIComponent(req.cookies.get('ps_device_name')?.value || '');
    const role = getAdminRole(req) || '';
    const db = await getDb();
    await db.execute({
      sql: `INSERT INTO audit_log (action, process_line, target, detail, role, device, device_name, ip, via)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        String(input.action),
        String(input.line ?? ''),
        String(input.target ?? '').slice(0, 500),
        (() => { try { return JSON.stringify(input.detail ?? {}); } catch { return '{}'; } })().slice(0, 1000),
        String(role),
        String(device).slice(0, 64),
        String(deviceName).slice(0, 64),
        String(ip).slice(0, 64),
        String(via).slice(0, 128),
      ],
    });
  } catch {
    // 로그 실패는 무시(삭제 기능을 막지 않는다)
  }
}

// 라인 조회 유틸: 주문/배정에서 process_line을 얻어 로그에 남기기 위함.
export async function lineOfOrder(orderId: number | string): Promise<string> {
  try {
    const db = await getDb();
    const r = await db.execute({ sql: 'SELECT process_line FROM orders WHERE id = ?', args: [orderId] });
    return String((r.rows[0] as Record<string, unknown>)?.process_line ?? '');
  } catch { return ''; }
}
