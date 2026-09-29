import { getDb } from './db';
import { parseParts } from './parts';

// CTP(판 출력) 연동 공용 로직.
// 매엽·윤전 담당자가 순서를 바꾸면 CTP는 모른 채 이전 순서대로 판을 출력해 늦는 문제가 있었다.
// 그래서 순서를 바꾸는 라우트(재배치·이동·배정·되돌리기)가 변경 전/후 시작시각을 비교해
//  1) 시작이 앞당겨진 항목·새로 들어온 항목·구성이 추가된 항목에 '변경 알림'(changed_at/change_note)을 남기고
//  2) 판이 아직 출력되지 않았는데 곧 시작하는 항목을 경고로 돌려준다(화면에서 확인창 표시).
// 완료·삭제 등으로 자연스럽게 앞당겨지는 경우는 순서 변경이 아니므로 알림을 남기지 않는다.

export const PLATE_LINES = ['매엽', '윤전'];   // 판(CTP 출력)이 필요한 공정 라인
export const PLATE_LEAD_MIN = 30;              // 작업 시작 몇 분 전까지 판이 준비돼야 하는지
export const PLATE_WARN_MIN = 120;             // 판 미출력 작업이 이 시간(분) 안에 시작하면 경고
const EARLIER_MIN = 10;                        // 이 시간(분) 이상 앞당겨져야 '변경'으로 본다

export interface PlateWarning {
  entry_id: number;
  machine: string;
  label: string;
  start: string; // 'YYYY-MM-DD HH:MM'
}

type Snap = Map<number, { start: string; parts: string }>;

function toMs(s: string): number {
  if (!s) return NaN;
  return new Date(s.replace(' ', 'T')).getTime();
}

// 'M/D HH:MM' (같은 날이면 'HH:MM'만)
function shortTime(s: string, refDay?: string): string {
  if (!s) return '';
  const day = s.slice(0, 10);
  const hm = s.slice(11, 16);
  if (refDay && day === refDay) return hm;
  return `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))} ${hm}`;
}

function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function plateMachineIds(machineIds: number[]): Promise<number[]> {
  const ids = Array.from(new Set(machineIds.map(Number).filter(Number.isFinite)));
  if (ids.length === 0) return [];
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT id FROM machines WHERE id IN (${ids.map(() => '?').join(',')}) AND process_line IN (${PLATE_LINES.map(() => '?').join(',')})`,
    args: [...ids, ...PLATE_LINES],
  });
  return r.rows.map((x) => Number((x as Record<string, unknown>).id));
}

// 라인의 판 대상 설비 id 전체(되돌리기처럼 라인 단위로 바뀌는 경우용)
export async function plateMachineIdsOfLine(line: string): Promise<number[]> {
  if (!PLATE_LINES.includes(line)) return [];
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT id FROM machines WHERE process_line = ?', args: [line] });
  return r.rows.map((x) => Number((x as Record<string, unknown>).id));
}

// 변경 전 상태 기록: 대상 설비들의 항목별 시작시각·구성.
export async function snapshotPlates(machineIds: number[]): Promise<Snap> {
  const snap: Snap = new Map();
  try {
    const ids = await plateMachineIds(machineIds);
    if (ids.length === 0) return snap;
    const db = await getDb();
    const r = await db.execute(`SELECT id, start_time, component_part FROM schedule_entries WHERE machine_id IN (${ids.join(',')})`);
    for (const row of r.rows as unknown as { id: number; start_time: string; component_part: string }[]) {
      snap.set(Number(row.id), { start: String(row.start_time || ''), parts: String(row.component_part || '') });
    }
  } catch {
    // 기록 실패는 본 기능을 막지 않는다
  }
  return snap;
}

// 변경 후 비교: 앞당겨진/새로 들어온/구성이 추가된 항목에 알림을 남기고, 곧 시작하는 판 미출력 항목을 경고로 반환.
//  notes: 특정 항목의 사유를 직접 지정(예: 'MB10→MB12 이동')
export async function flagPlateChanges(before: Snap, machineIds: number[], notes: Record<number, string> = {}): Promise<PlateWarning[]> {
  const warnings: PlateWarning[] = [];
  try {
    const ids = await plateMachineIds(machineIds);
    if (ids.length === 0) return warnings;
    const db = await getDb();
    const r = await db.execute(`
      SELECT se.id, se.start_time, se.component_part, se.plate_done_at, m.name AS machine_name,
             CASE WHEN se.entry_edited = 1 THEN se.entry_product_name ELSE o.product_name END AS product_name
      FROM schedule_entries se
      JOIN orders o ON se.order_id = o.id
      JOIN machines m ON se.machine_id = m.id
      WHERE se.machine_id IN (${ids.join(',')})`);
    const now = Date.now();
    const at = nowLocal();
    const stmts: { sql: string; args: (string | number)[] }[] = [];
    for (const row of r.rows as unknown as { id: number; start_time: string; component_part: string; plate_done_at: string; machine_name: string; product_name: string }[]) {
      const id = Number(row.id);
      const start = String(row.start_time || '');
      const prev = before.get(id);
      let note = notes[id] || '';
      let resetPlate = false;
      if (!note) {
        if (!prev) {
          note = '신규 배정';
        } else {
          const added = parseParts(String(row.component_part)).filter((p) => !parseParts(prev.parts).includes(p));
          if (added.length > 0) {
            note = `구성 추가: ${added.join(', ')}`;
            resetPlate = true; // 추가된 구성의 판은 아직 출력되지 않았다
          } else {
            const a = toMs(prev.start);
            const b = toMs(start);
            if (Number.isFinite(a) && Number.isFinite(b) && a - b >= EARLIER_MIN * 60000) {
              const ref = prev.start.slice(0, 10) === start.slice(0, 10) ? start.slice(0, 10) : undefined;
              note = `시작 앞당김 ${shortTime(prev.start, ref)}→${shortTime(start, ref)}`;
            }
          }
        }
      }
      if (!note) continue;
      stmts.push({
        sql: `UPDATE schedule_entries SET changed_at = ?, change_note = ?${resetPlate ? ", plate_done_at = '', plate_done_by = ''" : ''} WHERE id = ?`,
        args: [at, note.slice(0, 200), id],
      });
      const plateDone = !resetPlate && !!String(row.plate_done_at || '');
      const t = toMs(start);
      if (!plateDone && Number.isFinite(t) && t - now <= PLATE_WARN_MIN * 60000) {
        const part = String(row.component_part || '');
        warnings.push({
          entry_id: id,
          machine: String(row.machine_name),
          label: `${row.product_name}${part ? ` (${part})` : ''}`,
          start,
        });
      }
    }
    if (stmts.length) await db.batch(stmts, 'write');
  } catch {
    // 알림 기록 실패는 본 기능(순서 변경)을 막지 않는다
  }
  warnings.sort((a, b) => a.start.localeCompare(b.start));
  return warnings;
}
