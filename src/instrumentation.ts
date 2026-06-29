// 서버가 시작될 때(=업데이트로 재시작될 때) 전 설비 일정을 현재 계산 로직으로 한 번 자동 재계산한다.
// 평소 완료시각은 작업 배정·순서변경·식사시간/비가동/근무시간 수정 때마다 설비별로 자동 재계산되지만,
// 계산 '규칙(코드)'이 바뀐 경우엔 기존 일정이 자동 갱신되지 않으므로, 시작 시 일괄 재계산으로 반영한다.
// (수동 '전체 재계산' 버튼을 대체)
export function register() {
  // Node.js 런타임에서만 (엣지 런타임 제외)
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // 서버 시작을 막지 않도록 백그라운드로 실행한다.
  void (async () => {
    try {
      const { recalcAllMachines } = await import('@/lib/calc');
      await recalcAllMachines();
      console.log('[startup] 전 설비 예상완료시간 재계산 완료');
    } catch (e) {
      console.error('[startup] 전 설비 재계산 실패', e);
    }
  })();
}
