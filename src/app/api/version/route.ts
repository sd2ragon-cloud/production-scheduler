import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

// 배포 검증용: auto-update.ps1이 배포 완료 시 cwd(C:\production-scheduler)에 기록하는
// .last_sha 를 그대로 노출한다. 라이브 서버가 실제로 어느 커밋을 띄우고 있는지 확인 가능.
export const dynamic = 'force-dynamic'; // 빌드 시 캐시 금지, 매 요청마다 .last_sha 읽기

// buildTag: .last_sha(파일)와 달리 "실제 빌드된 코드"에 박혀 있는 값.
// auto-update가 빌드 실패 시에도 .last_sha만 갱신하던 버그 때문에 deployedSha가 거짓일 수 있으므로,
// 라이브 서버가 정말 이 코드로 빌드됐는지는 이 buildTag로 확인한다. 코드 의미 변경 시마다 올린다.
const BUILD_TAG = 'jechae-weekday-panel-top-2026-07-28';

export async function GET() {
  let deployedSha = 'unknown';
  try {
    deployedSha = (await readFile(path.join(process.cwd(), '.last_sha'), 'utf8')).trim();
  } catch {
    deployedSha = 'dev'; // .last_sha 없는 개발 환경
  }
  return NextResponse.json({
    deployedSha,
    buildTag: BUILD_TAG,
    startedAt: new Date().toISOString(),
  });
}
