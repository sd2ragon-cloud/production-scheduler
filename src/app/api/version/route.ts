import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

// 배포 검증용: auto-update.ps1이 배포 완료 시 cwd(C:\production-scheduler)에 기록하는
// .last_sha 를 그대로 노출한다. 라이브 서버가 실제로 어느 커밋을 띄우고 있는지 확인 가능.
export const dynamic = 'force-dynamic'; // 빌드 시 캐시 금지, 매 요청마다 .last_sha 읽기

export async function GET() {
  let deployedSha = 'unknown';
  try {
    deployedSha = (await readFile(path.join(process.cwd(), '.last_sha'), 'utf8')).trim();
  } catch {
    deployedSha = 'dev'; // .last_sha 없는 개발 환경
  }
  return NextResponse.json({
    deployedSha,
    startedAt: new Date().toISOString(),
  });
}
