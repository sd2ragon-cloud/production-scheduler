// 단면 전용 설비 목록 (이 외 설비는 모두 양면 가능)
export const SINGLE_SIDED_MACHINES = ["MB4-3", "MB5-1", "MB6"];

export function isDoubleSided(machineName: string): boolean {
  return !SINGLE_SIDED_MACHINES.includes((machineName || "").trim());
}

// 단면 기준 원본 소요시간(base)에 인쇄 모드를 적용한 실제 소요시간(분).
// 양면(double) 인쇄는 한 번에 양면을 찍으므로 시간이 절반.
export function effectiveMinutes(baseMinutes: number, mode: string): number {
  const b = Number(baseMinutes) || 0;
  return mode === "single" ? b : Math.round(b / 2);
}
