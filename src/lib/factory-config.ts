export const FACTORY_PROCESS_MAP: Record<string, string[]> = {
  '본공장': ['매엽', '윤전', '무선'],
  '패키지공장': ['OV/CR코팅', '라미네이팅', '톰슨'],
};

export const FACTORIES = Object.keys(FACTORY_PROCESS_MAP);

export const DEFAULT_FACTORY = '본공장';
export const DEFAULT_PROCESS = '매엽';
