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

  // Migrate orders: add bucket_id (1차 배정 칸) column if missing. NULL = 배정 대기.
  try {
    await db.execute(`ALTER TABLE orders ADD COLUMN bucket_id INTEGER`);
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

  // Migrate schedule_entries: add base_minutes (단면 기준 원본 소요시간) column if missing
  try {
    await db.execute(`ALTER TABLE schedule_entries ADD COLUMN base_minutes INTEGER NOT NULL DEFAULT 0`);
    // 기존 행 백필: 단면 기준 base를 현재 소요시간으로 간주 (기존 통째 작업은 모두 단면이었음)
    await db.execute(`UPDATE schedule_entries SET base_minutes = duration_minutes WHERE base_minutes = 0`);
  } catch {
    // column already exists
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
