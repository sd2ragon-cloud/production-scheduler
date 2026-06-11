import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

// 외부 접속용 Cloudflare 터널의 현재 공개 URL을 노출한다.
// 노트북의 deploy/tunnel.ps1 이 터널을 띄울 때마다 cwd(C:\production-scheduler)의
// tunnel-url.txt 에 현재 URL을 기록한다. Quick Tunnel은 (cloudflared 재시작 시) URL이
// 바뀌므로, 팀은 사내에서 이 값을 확인해 외부/휴대폰 접속 주소로 사용한다.
// 도메인을 붙여 named tunnel로 올리면 영구 주소가 되어 이 값이 고정된다.
export const dynamic = 'force-dynamic'; // 매 요청마다 tunnel-url.txt 다시 읽기

export async function GET() {
  let url = '';
  try {
    url = (await readFile(path.join(process.cwd(), 'tunnel-url.txt'), 'utf8')).trim();
  } catch {
    url = ''; // 파일 없음(개발 환경 또는 터널 미실행)
  }
  return NextResponse.json({ url });
}
