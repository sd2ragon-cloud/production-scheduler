// 주문의 '구성' 필드를 쉼표 기준으로 파트 목록으로 분리한다.
// 예: "표지, 1대, 2대, 3대, 4대" -> ["표지", "1대", "2대", "3대", "4대"]
export function parseParts(component: string): string[] {
  if (!component) return [];
  return component
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 파트별 소요시간(분) 맵을 안전하게 파싱
export function parsePartDurations(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" ? (obj as Record<string, number>) : {};
  } catch {
    return {};
  }
}

// 파트별 구분(공정) 맵을 안전하게 파싱
export function parsePartProcesses(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// 파트별 1차 배정 칸 맵을 안전하게 파싱. 값은 칸 id(number) 또는 명시적 미배정(null).
// 맵에 없는 구성은 호출부에서 주문 전체 bucket_id로 폴백한다(하위호환).
export function parsePartBuckets(json: string | null | undefined): Record<string, number | null> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null) out[k] = null;
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// 파트별 소요시간 합계(분)
export function sumDurations(durations: Record<string, number>): number {
  return Object.values(durations).reduce((a, b) => a + (Number(b) || 0), 0);
}

// 주문의 파트별 "총" 소요시간(분) 맵. 단일 구성이면 주문 전체 소요시간을 그 파트의 총량으로 사용.
export function partTotals(
  component: string,
  partDurationsJson: string | null | undefined,
  durationMinutes: number,
): Record<string, number> {
  const parts = parseParts(component);
  if (parts.length === 0) return {};
  const pd = parsePartDurations(partDurationsJson);
  const totals: Record<string, number> = {};
  for (const p of parts) {
    if (p in pd) totals[p] = Number(pd[p]) || 0;
    else if (parts.length === 1) totals[p] = Number(durationMinutes) || 0;
    else totals[p] = 0;
  }
  return totals;
}
