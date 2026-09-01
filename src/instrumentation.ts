// 서버 시작 시 1회 실행(Next instrumentation). 운영 노트북에서 Funnel keepalive를 띄워
// 외부 접속(Tailscale Funnel)이 끊겨도 앱이 스스로 되살리게 한다.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startFunnelKeepalive } = await import('./lib/funnel-keepalive');
    startFunnelKeepalive();
  }
}
