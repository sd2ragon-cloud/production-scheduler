// 설비 근무체제(교대) 정의. 시간은 자정 기준 '분'. end가 1440(24:00)을 넘으면 익일까지 이어진다.
//  정상(주): 08:30 ~ 당일 20:30
//  정상(야): 20:30 ~ 익일 08:30  (자정 넘김)
//  정시(주): 08:30 ~ 당일 15:30
//  정시(야): 15:30 ~ 당일 22:30
//  단부정시: 08:30 ~ 당일 17:30
//  야업(20시): 08:30 ~ 당일 20:00
//  야업(21시): 08:30 ~ 당일 21:00
//  야업(22시): 08:30 ~ 당일 22:00
//  야업(23시): 08:30 ~ 당일 23:00
//  야업(24시): 08:30 ~ 당일 24:00
export interface ShiftDef {
  start: number; // 분 (자정 기준)
  end: number;   // 분 (자정 기준; 1440 초과면 익일)
}

export const SHIFTS: Record<string, ShiftDef> = {
  "정상(주)": { start: 8 * 60 + 30, end: 20 * 60 + 30 },
  "정상(야)": { start: 20 * 60 + 30, end: 24 * 60 + 8 * 60 + 30 },
  "정시(주)": { start: 8 * 60 + 30, end: 15 * 60 + 30 },
  "정시(야)": { start: 15 * 60 + 30, end: 22 * 60 + 30 },
  "단부정시": { start: 8 * 60 + 30, end: 17 * 60 + 30 },
  "야업(20시)": { start: 8 * 60 + 30, end: 20 * 60 },
  "야업(21시)": { start: 8 * 60 + 30, end: 21 * 60 },
  "야업(22시)": { start: 8 * 60 + 30, end: 22 * 60 },
  "야업(23시)": { start: 8 * 60 + 30, end: 23 * 60 },
  "야업(24시)": { start: 8 * 60 + 30, end: 24 * 60 },
};

// 특수 근무체제 마커(실제 근무시간 없음 → 스케줄상 무근무).
//  휴무: 그 날 쉼(대시보드에 '휴무' 그대로 표기).
//  완료: 오늘 작업 완료 — 대시보드엔 '다음날'의 근무체제를 대신 표기(다음날 계획을 미리 보기 위함).
export const SHIFT_MARKERS = ["휴무", "완료"] as const;
export function isShiftMarker(name: string): boolean {
  return (SHIFT_MARKERS as readonly string[]).includes(name);
}
// 저장/파싱에서 허용하는 근무체제명(실제 교대 + 마커).
export function isValidShiftName(name: string): boolean {
  return name in SHIFTS || isShiftMarker(name);
}

// 칩 표시 순서 (실제 교대 + 마커)
export const SHIFT_NAMES: string[] = ["정상(주)", "정상(야)", "정시(주)", "정시(야)", "단부정시", "야업(20시)", "야업(21시)", "야업(22시)", "야업(23시)", "야업(24시)", "휴무", "완료"];

// 요일별 근무체제 JSON 파싱. { "1": ["정상(주)","정상(야)"], ... } (키=요일 0=일~6=토).
export function parseDayShifts(json: string | undefined | null): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  if (!json) return out;
  try {
    const o = JSON.parse(json);
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const d = Number(k);
        const arr = (o as Record<string, unknown>)[k];
        if (d >= 0 && d <= 6 && Array.isArray(arr)) {
          const names = arr.filter((x): x is string => typeof x === "string" && isValidShiftName(x));
          if (names.length) out[d] = names;
        }
      }
    }
  } catch {
    /* 잘못된 JSON → 없음 */
  }
  return out;
}

// 근무체제 설정이 하나라도 있으면 true(있으면 구버전 시작/종료 대신 근무체제를 사용).
export function hasDayShifts(json: string | undefined | null): boolean {
  return Object.keys(parseDayShifts(json)).length > 0;
}

// 일자별 예외 근무체제 JSON 파싱. { "2026-07-10": ["정상(주)","정상(야)"], "2026-08-15": [] }
// (키='YYYY-MM-DD', 값=근무체제명 배열). day_shifts와 달리 빈 배열도 유지한다 — '그 날 휴무'를 뜻함.
export function parseDateShifts(json: string | undefined | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!json) return out;
  try {
    const o = JSON.parse(json);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of Object.keys(o)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        const arr = (o as Record<string, unknown>)[k];
        if (Array.isArray(arr)) {
          out[k] = arr.filter((x): x is string => typeof x === "string" && isValidShiftName(x));
        }
      }
    }
  } catch {
    /* 잘못된 JSON → 없음 */
  }
  return out;
}
