import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  const db = getDb();
  const machines = db.prepare('SELECT * FROM machines ORDER BY id').all();
  return NextResponse.json(machines);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO machines (name, description, speed_sheets_per_hour, setup_time_minutes, capabilities, work_start_hour, work_end_hour, works_saturday, works_sunday)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    body.name,
    body.description || '',
    body.speed_sheets_per_hour || 1000,
    body.setup_time_minutes || 30,
    JSON.stringify(body.capabilities || ['일반']),
    body.work_start_hour || 8,
    body.work_end_hour || 22,
    body.works_saturday ? 1 : 0,
    body.works_sunday ? 1 : 0
  );

  return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
}
