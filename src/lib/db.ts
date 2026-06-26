import { createClient, Client } from '@libsql/client';

let client: Client | null = null;
let initialized = false;

export async function getDb(): Promise<Client> {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL || 'file:data/production.db',
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  if (!initialized) {
    await initializeDb(client);
    initialized = true;
  }
  return client;
}

async function initializeDb(db: Client) {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      speed_sheets_per_hour REAL NOT NULL DEFAULT 1000,
      setup_time_minutes INTEGER NOT NULL DEFAULT 30,
      capabilities TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      work_start_hour INTEGER NOT NULL DEFAULT 8,
      work_end_hour INTEGER NOT NULL DEFAULT 22,
      works_saturday INTEGER NOT NULL DEFAULT 1,
      works_sunday INTEGER NOT NULL DEFAULT 0,
      factory TEXT NOT NULL DEFAULT '본공장',
      process_line TEXT NOT NULL DEFAULT '매엽',
      schedule_start_time TEXT NOT NULL DEFAULT '08:00',
      memo TEXT NOT NULL DEFAULT '',
      extra_notes TEXT NOT NULL DEFAULT '',
      off_days TEXT NOT NULL DEFAULT '[0]',
      day_hours TEXT NOT NULL DEFAULT '',
      day_shifts TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      component TEXT NOT NULL DEFAULT '',
      quantity_sheets REAL NOT NULL,
      deadline TEXT NOT NULL,
      special_process TEXT DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 5,
      notes TEXT DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      part_durations TEXT NOT NULL DEFAULT '{}',
      part_quantities TEXT NOT NULL DEFAULT '{}',
      extra_notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      factory TEXT NOT NULL DEFAULT '본공장',
      process_line TEXT NOT NULL DEFAULT '매엽',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS schedule_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      machine_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      component_part TEXT NOT NULL DEFAULT '',
      part_durations TEXT NOT NULL DEFAULT '{}',
      print_mode TEXT NOT NULL DEFAULT 'single',
      scheduled_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_entries(scheduled_date)`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_machine ON schedule_entries(machine_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
    `CREATE TABLE IF NOT EXISTS buckets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      process_line TEXT NOT NULL DEFAULT '매엽',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    // 식사·휴게 시간(자정 기준 분 단위). 이 시간대에는 작업하지 않으므로 예상완료시간 계산에서 제외된다.
    `CREATE TABLE IF NOT EXISTS breaks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    // 앱 설정 키/값 저장소. 관리자 비밀번호 해시(admin_pw = salt:hash) 등을 보관한다.
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ], 'write');

  // Migrate existing tables: add factory/process_line columns if missing
  for (const table of ['machines', 'orders']) {
    for (const col of [
      { name: 'factory', def: "'본공장'" },
      { name: 'process_line', def: "'매엽'" },
    ]) {
      try {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col.name} TEXT NOT NULL DEFAULT ${col.def}`);
      } catch {
        // column already exists
      }
    }
  }

  // Migrate orders: add duration_minutes column if missing
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // column already exists
  }

  // Migrate orders: add part_durations column if missing
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN part_durations TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // column already exists
  }

  // Migrate orders: add part_processes (파트별 구분/공정) column if missing
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN part_processes TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // column already exists
  }

  // Migrate orders: add part_quantities (파트별 수량/부, 윤전) column if missing
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN part_quantities TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // column already exists
  }

  // Migrate orders: add extra_notes (기타사항, 제책 등) column if missing
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN extra_notes TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }

  // Migrate orders: add bucket_id (1차 배정 칸) column if missing. NULL = 배정 대기.
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN bucket_id INTEGER`);
  } catch {
    // column already exists
  }

  // Migrate orders: add part_buckets (구성별 1차 배정 칸 매핑 JSON) column if missing.
  // 예: {"표지": 3, "본문": 5}. 구성을 칸별로 나눠 배정할 때 사용한다. 값이 칸 id면 그 칸,
  // null이면 명시적 미배정(대기). 맵에 없는 구성은 주문 전체 bucket_id를 따른다(하위호환).
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN part_buckets TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // column already exists
  }

  // Migrate schedule_entries: add component_part column if missing
  try {
    await db.execute(`ALTER TABLE schedule_entries ADD COLUMN component_part TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }

  // Migrate schedule_entries: add part_durations column if missing
  try {
    await db.execute(`ALTER TABLE schedule_entries ADD COLUMN part_durations TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // column already exists
  }

  // Migrate schedule_entries: add print_mode column if missing
  try {
    await db.execute(`ALTER TABLE schedule_entries ADD COLUMN print_mode TEXT NOT NULL DEFAULT 'single'`);
  } catch {
    // column already exists
  }

  // Migrate machines: add sort_order (대시보드 표시 순서) column if missing
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    // 기존 설비는 id 순서를 초기 표시 순서로 사용
    await db.execute(`UPDATE machines SET sort_order = id WHERE sort_order = 0`);
  } catch {
    // column already exists
  }

  // Migrate machines: add schedule_start_time (기계별 일일 작업 시작 시각) column if missing.
  // 영속화하여 배정해제·소요시간변경 등 start_time 없는 재계산에서도 시작시각이 유지된다.
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN schedule_start_time TEXT NOT NULL DEFAULT '08:00'`);
  } catch {
    // column already exists
  }

  // Migrate machines: add memo (설비명 옆 수기 자유 메모) column if missing
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN memo TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }

  // Migrate machines: add extra_notes (설비 블록 하단 기타사항 자유 입력, 제책 등) column if missing
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN extra_notes TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }

  // Migrate machines: add off_days (요일별 휴무 JSON 배열, 0=일~6=토). 기존 토/일 설정을 이관한다.
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN off_days TEXT NOT NULL DEFAULT '[0]'`);
    // 최초 1회 백필: works_saturday/works_sunday(0=휴무)에서 off_days를 계산해 채운다.
    const rows = await db.execute('SELECT id, works_saturday, works_sunday FROM machines');
    for (const r of rows.rows as unknown as { id: number; works_saturday: number; works_sunday: number }[]) {
      const off: number[] = [];
      if (Number(r.works_sunday) === 0) off.push(0);
      if (Number(r.works_saturday) === 0) off.push(6);
      await db.execute({ sql: 'UPDATE machines SET off_days = ? WHERE id = ?', args: [JSON.stringify(off), Number(r.id)] });
    }
  } catch {
    // column already exists (백필은 최초 1회만)
  }

  // Migrate machines: add day_hours (요일별 근무시간 오버라이드 JSON, 예 {"6":[8,18]}).
  // 비어 있으면 work_start_hour/work_end_hour를 모든 근무일에 적용(기존 동작 유지).
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN day_hours TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }

  // Migrate machines: add day_shifts (요일별 근무체제 JSON). 비어 있으면 구버전 시작/종료 사용.
  try {
    await db.execute(`ALTER TABLE machines ADD COLUMN day_shifts TEXT NOT NULL DEFAULT ''`);
  } catch {
    // column already exists
  }

  // 1회성: 납기일 기능 제거에 따라 기존 주문의 deadline 데이터를 전부 비운다.
  // 마커 테이블 생성이 성공한 최초 1회에만 실행(이후 재시작 시엔 테이블이 이미 있어 건너뜀).
  try {
    await db.execute(`CREATE TABLE _deadline_cleared (id INTEGER PRIMARY KEY)`);
    await db.execute(`UPDATE orders SET deadline = ''`);
  } catch {
    // 이미 실행됨(마커 존재) → 건너뜀
  }

  // Migrate schedule_entries: add base_minutes (단면 기준 원본 소요시간) column if missing
  try {
    await db.execute(`ALTER TABLE schedule_entries ADD COLUMN base_minutes INTEGER NOT NULL DEFAULT 0`);
    // 기존 행 백필: 단면 기준 base를 현재 소요시간으로 간주 (기존 통째 작업은 모두 단면이었음)
    await db.execute(`UPDATE schedule_entries SET base_minutes = duration_minutes WHERE base_minutes = 0`);
  } catch {
    // column already exists
  }

  // 관리자 비밀번호 역할 분리 마이그레이션: 기존 단일 admin_pw가 있으면 매엽·윤전 관리자(admin_pw_sheet)로 이관.
  // (전사 총괄 없이 매엽·윤전 / 무선 두 모드로 운영. 무선 비밀번호는 첫 사용 시 새로 설정한다.)
  try {
    const legacy = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: ['admin_pw'] });
    if (legacy.rows.length > 0) {
      const val = String((legacy.rows[0] as unknown as { value: string }).value);
      const sheet = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: ['admin_pw_sheet'] });
      if (val && sheet.rows.length === 0) {
        await db.execute({
          sql: `INSERT INTO settings (key, value) VALUES ('admin_pw_sheet', ?) ON CONFLICT(key) DO NOTHING`,
          args: [val],
        });
      }
      // 기존 단일 키는 더 이상 사용하지 않으므로 정리
      await db.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: ['admin_pw'] });
    }
  } catch {
    // settings 미생성 등 예외는 무시 (위 배치에서 테이블은 항상 생성됨)
  }

  // '무선' 라인을 '제책'으로 명칭 변경: 기존 데이터의 process_line 값을 이전한다.
  try {
    for (const table of ['machines', 'orders', 'buckets']) {
      await db.execute({ sql: `UPDATE ${table} SET process_line = '제책' WHERE process_line = '무선'`, args: [] });
    }
  } catch {
    // 컬럼/테이블 미생성 등 예외는 무시
  }

  const result = await db.execute('SELECT COUNT(*) as count FROM machines');
  const count = Number(result.rows[0].count);
  if (count === 0) {
    await seedData(db);
  }

  // 1차 배정 칸 기본값 시드 (비어 있을 때만) — 기존 DB도 다음 기동 시 기본 칸이 생긴다.
  const bucketResult = await db.execute('SELECT COUNT(*) as count FROM buckets');
  if (Number(bucketResult.rows[0].count) === 0) {
    await seedBuckets(db);
  }

  // 식사·휴게 시간 기본값 시드 (비어 있을 때만). 기존 calc.ts 고정값과 동일하게 점심/저녁/야식을 넣어
  // 기존 동작을 그대로 유지한다. 이후엔 앱에서 추가/수정/삭제로 관리한다.
  const breakResult = await db.execute('SELECT COUNT(*) as count FROM breaks');
  if (Number(breakResult.rows[0].count) === 0) {
    await seedBreaks(db);
  }
}

async function seedBreaks(db: Client) {
  const defaults: [string, number, number][] = [
    ['점심', 12 * 60, 13 * 60],
    ['저녁', 17 * 60 + 30, 18 * 60 + 30],
    ['야식', 0 * 60, 1 * 60],
  ];
  await db.batch(
    defaults.map(([name, start, end]) => ({
      sql: `INSERT INTO breaks (name, start_min, end_min) VALUES (?, ?, ?)`,
      args: [name, start, end] as (string | number)[],
    })),
    'write',
  );
}

async function seedBuckets(db: Client) {
  const names = ['국', '4×6', 'MB6', 'HDP'];
  await db.batch(
    names.map((name, i) => ({
      sql: `INSERT INTO buckets (name, process_line, sort_order) VALUES (?, ?, ?)`,
      args: [name, '매엽', i + 1] as (string | number)[],
    })),
    'write',
  );
}

async function seedData(db: Client) {
  const machines: (string | number)[][] = [
    ['MB10', '매엽 10색 인쇄기', 3000, 30, '["일반","항바니쉬"]', 8, 22, 1, '본공장', '매엽'],
    ['MBTP', '매엽 TP 인쇄기', 2800, 30, '["일반","항바니쉬"]', 8, 22, 1, '본공장', '매엽'],
    ['MB8', '매엽 8색 인쇄기', 2500, 25, '["일반","양면"]', 8, 22, 1, '본공장', '매엽'],
    ['MB4-3', '매엽 4색 3호기 (UV)', 1500, 40, '["UV","비닐스티커","유포지"]', 8, 22, 1, '본공장', '매엽'],
    ['MB5-1', '매엽 5색 1호기', 2000, 30, '["일반"]', 8, 22, 1, '본공장', '매엽'],
    ['MB6', '매엽 6색 (UV/IR)', 2000, 35, '["UV","IR코팅","OHP"]', 8, 22, 1, '본공장', '매엽'],
    ['HDP', 'HDP 인쇄기', 2200, 30, '["일반","양면","패키지"]', 8, 22, 1, '본공장', '매엽'],
  ];

  const orders: (string | number)[][] = [
    ['', '골드앤와이즈', '본문1대~3대', 21, '2026-06-05', '일반', 3, '', '본공장', '매엽'],
    ['', '골드앤와이즈', '본문4대~6대', 21, '2026-06-05', '일반', 3, '', '본공장', '매엽'],
    ['', '국어1-2 가', '표지', 12, '2026-06-02', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 나', '표지', 12, '2026-06-03', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 가', '부록2', 12, '2026-06-04', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 가', '부록4', 11, '2026-06-04', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 가', '부록1', 6, '2026-06-04', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 가', '부록11', 23, '2026-06-03', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 나', '본문1대', 15, '2026-06-05', '항바니쉬', 5, '항바니쉬인쇄-5도', '본공장', '매엽'],
    ['', '국어1-2 나', '본문3대,7대', 23, '2026-06-05', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 나', '본문12대', 3, '2026-06-06', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 나', '부록4,부록5', 23, '2026-06-06', '일반', 5, '', '본공장', '매엽'],
    ['', '국어1-2 나', '부록6,8,9대 유포지', 65, '2026-06-08', 'UV', 5, '유포지 706R', '본공장', '매엽'],
    ['', '국어1-2 나', '부록2대 비닐스티커', 17, '2026-06-09', 'UV', 5, '비닐스티커 176.5R', '본공장', '매엽'],
    ['', '국어활동3-2', '표지', 13, '2026-06-02', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동3-2', '부록7', 13, '2026-06-05', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동3-2', '부록5,부록6', 13, '2026-06-06', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동3-2', '부록3,부록4대', 13, '2026-06-07', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동3-2', '부록8대', 13, '2026-06-07', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동3-2', '부록1,부록2대', 13, '2026-06-08', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동4-2', '표지', 15, '2026-06-03', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동4-2', '본문7대', 19, '2026-06-04', '항바니쉬', 5, '항바니쉬인쇄-5도', '본공장', '매엽'],
    ['', '국어활동4-2', '부록1,부록2대', 15, '2026-06-05', '항바니쉬', 5, '항바니쉬인쇄-5도, 4*6', '본공장', '매엽'],
    ['', '국어활동4-2', '부록7대', 15, '2026-06-06', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동4-2', '부록3,부록4대', 15, '2026-06-07', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동4-2', '부록5,부록6대', 15, '2026-06-08', '일반', 5, '', '본공장', '매엽'],
    ['', '국어활동4-2', '부록8대', 29, '2026-06-07', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '표지', 13, '2026-06-04', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '부록3대', 7, '2026-06-05', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '본문5대', 13, '2026-06-06', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '부록8대', 26, '2026-06-07', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '부록1대', 7, '2026-06-07', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '부록2,부록5대', 26, '2026-06-08', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 가', '부록7대 비닐스티커', 19, '2026-06-10', 'UV', 5, '비닐스티커 203R', '본공장', '매엽'],
    ['', '국어3-2 가', '부록6대 유포지', 19, '2026-06-11', 'UV', 5, '유포지 203R', '본공장', '매엽'],
    ['', '국어3-2 가', '본문11,12대 OHP', 41, '2026-06-08', 'UV', 5, 'OHP 406R', '본공장', '매엽'],
    ['', '국어3-2 나', '표지', 13, '2026-06-05', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 나', '부록8대', 13, '2026-06-06', '일반', 5, '', '본공장', '매엽'],
    ['', '국어3-2 나', '부록2대', 27, '2026-06-09', '양면', 5, '양면', '본공장', '매엽'],
    ['', '국어3-2 나', '부록5대', 13, '2026-06-09', '양면', 5, '양면', '본공장', '매엽'],
    ['', '국어3-2 나', '부록11대', 7, '2026-06-09', '양면', 5, '양면', '본공장', '매엽'],
    ['', '국어3-2 나', '부록3,6,9,12,13대 유포지', 93, '2026-06-12', 'UV', 5, '유포지 1015R', '본공장', '매엽'],
    ['', '국어4-2 가', '부록2,7,8대 비닐스티커', 63, '2026-06-15', 'UV', 5, '비닐스티커 682.5R', '본공장', '매엽'],
    ['', '국어4-2 가', '본문16대 OHP', 23, '2026-06-10', 'UV', 5, 'OHP 227.5R', '본공장', '매엽'],
    ['0522', '오뚜기콤비네이션피자', '패키지', 6, '2026-05-30', '패키지', 7, '조흥', '본공장', '매엽'],
    ['0522', '오뚜기트러플치즈투움바피자', '패키지', 2, '2026-05-30', '패키지', 7, '조흥', '본공장', '매엽'],
    ['0522', '오뚜기고구마크러스트콤보피자', '패키지', 2, '2026-05-30', '패키지', 7, '조흥', '본공장', '매엽'],
    ['0526', '3분카레약간매운맛', '패키지', 5, '2026-05-31', '패키지', 7, '오뚜기', '본공장', '매엽'],
    ['0527', '초코칩쿠키말차104g케이스1500', '패키지', 3, '2026-06-01', '패키지', 7, '오리온', '본공장', '매엽'],
    ['0522', 'CU피자득템고구마', '패키지', 3, '2026-05-28', '패키지', 9, '조흥, 5/28(목)13시 감리有', '본공장', '매엽'],
    ['0522', 'CU더블포테이토베이컨피자', '패키지', 3, '2026-05-28', '패키지', 9, '조흥, 5/28(목) 감리有', '본공장', '매엽'],
    ['0526', '더존킬라파워유제데카메트린250ml', '패키지', 1, '2026-06-01', '패키지', 5, '성진', '본공장', '매엽'],
    ['0526', '여름방학간식박스', '패키지', 1, '2026-06-02', 'IR코팅', 5, '미래엔', '본공장', '매엽'],
    ['0526', '청정원스파이시콤비네이션피자케이스', '패키지', 3, '2026-06-02', 'IR코팅', 5, '신세계', '본공장', '매엽'],
    ['0527', '두드림슬림웨어쾌변직빵', '패키지', 1, '2026-06-02', 'IR코팅', 5, '웰파인, 6/2(화) 감리有', '본공장', '매엽'],
  ];

  const stmts: { sql: string; args: (string | number)[] }[] = [];

  for (const m of machines) {
    stmts.push({
      sql: `INSERT INTO machines (name, description, speed_sheets_per_hour, setup_time_minutes, capabilities, work_start_hour, work_end_hour, works_saturday, factory, process_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: m,
    });
  }

  for (const o of orders) {
    stmts.push({
      sql: `INSERT INTO orders (order_code, product_name, component, quantity_sheets, deadline, special_process, priority, notes, factory, process_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: o,
    });
  }

  await db.batch(stmts, 'write');
}
