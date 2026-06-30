// 특정 주문의 원본 데이터(구성·파트별 소요시간·1차배정 맵·상태)와 그 주문의 모든 배정 엔트리를 덤프한다.
// 부품이 화면에서 안 보이는 원인 진단용. 운영 노트북에서 실행:
//   node scripts/dump-order.mjs "국어5-2 나"
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*(TURSO_DATABASE_URL|TURSO_AUTH_TOKEN)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 없음 */ }
}

const name = process.argv[2] || '국어5-2';
const url = process.env.TURSO_DATABASE_URL || 'file:data/production.db';
const authToken = process.env.TURSO_AUTH_TOKEN;
const db = createClient(authToken ? { url, authToken } : { url });

const orders = await db.execute({
  sql: `SELECT id, product_name, process_line, component, part_durations, part_processes, part_buckets, bucket_id, status, duration_minutes
        FROM orders WHERE product_name LIKE ?`,
  args: [`%${name}%`],
});
console.log('===== ORDERS (' + orders.rows.length + ') =====');
for (const o of orders.rows) {
  console.log(JSON.stringify(o, null, 1));
  const ents = await db.execute({
    sql: `SELECT se.id, se.machine_id, m.name AS machine, m.is_active, m.process_line AS m_line,
                 se.component_part, se.part_durations, se.duration_minutes, se.sequence
          FROM schedule_entries se LEFT JOIN machines m ON se.machine_id = m.id
          WHERE se.order_id = ? ORDER BY se.machine_id, se.sequence`,
    args: [o.id],
  });
  console.log(`  --- ENTRIES for order ${o.id} (${ents.rows.length}) ---`);
  for (const e of ents.rows) console.log('   ' + JSON.stringify(e));
}
console.log('===== END =====');
