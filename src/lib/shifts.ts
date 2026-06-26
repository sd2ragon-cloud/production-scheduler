// 설비 근무체제(교대) 정의. 시간은 자정 기준 '분'. end가 1440(24:00)을 넘으면 익일까지 이어진다.
//  정상(주): 08:30 ~ 당일 20:30
//  정상(야): 20:30 ~ 익일 08:30  (자정 넘김)
//  정시(주): 08:30 ~ 당일 15:30
//  정시(야): 15:30 ~ 당일 22:30
//  단부정시: 08:30 ~ 당일 17:30
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
};

// 칩 표시 순서
export const SHIFT_NAMES: string[] = ["정상(주)", "정상(야)", "정시(주)", "정시(야)", "단부정시"];

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
          const names = arr.filter((x): x is string => typeof x === "string" && x in SHIFTS);
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
