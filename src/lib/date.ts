// 로컬(설치 지역, 예: KST) 기준 오늘 날짜 'YYYY-MM-DD'.
// new Date().toISOString()은 UTC 기준이라 한국시간 오전 9시 이전엔 하루 전 날짜가 되어,
// 재계산 기준일이 '어제'로 잡히고 일정이 과거 요일에 배정되는 문제가 있었다. 로컬 날짜를 직접 만든다.
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
