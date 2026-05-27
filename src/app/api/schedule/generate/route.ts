import { NextRequest, NextResponse } from 'next/server';
import { generateSchedule, saveSchedule } from '@/lib/scheduler';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const targetDate = body.target_date || undefined;

  const { entries, warnings } = generateSchedule(targetDate);

  if (entries.length > 0) {
    saveSchedule(entries);
  }

  return NextResponse.json({
    success: true,
    total_entries: entries.length,
    warnings,
  });
}
