import { NextRequest, NextResponse } from 'next/server';
import { recalcMachine } from '@/lib/calc';

export async function POST(req: NextRequest) {
  const { machine_id, start_time } = await req.json();

  const today = new Date().toISOString().split('T')[0];
  await recalcMachine(machine_id, today, start_time);

  return NextResponse.json({ success: true });
}
