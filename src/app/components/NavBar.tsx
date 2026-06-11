"use client";

import { useEffect, useState } from "react";
import { PROCESS_LINES } from "@/lib/factory-config";
import { useProcess } from "./ProcessContext";

export default function NavBar() {
  const { processLine, setProcessLine } = useProcess();
  const [extUrl, setExtUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // 외부 접속 주소(Cloudflare 터널 URL)를 가져온다. 터널이 안 떠 있으면 빈 값 → 버튼 숨김.
  useEffect(() => {
    let alive = true;
    fetch("/api/tunnel")
      .then((r) => r.json())
      .then((d) => { if (alive && d && typeof d.url === "string") setExtUrl(d.url); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 클릭 = 외부 주소를 클립보드에 복사(휴대폰/외부망에 전달용). 권한 없으면 새 탭으로 연다.
  const copyExt = async () => {
    if (!extUrl) return;
    try {
      await navigator.clipboard.writeText(extUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.open(extUrl, "_blank");
    }
  };

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="w-full px-10 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <a href="/" className="text-lg font-bold text-gray-900 mr-3">생산 스케줄링</a>
          <a href="/" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">대시보드</a>
          <a href="/orders" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">주문 관리</a>
          <a href="/machines" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">설비 관리</a>
          <a href="/schedule" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">스케줄 보기</a>
        </div>
        <div className="flex items-center gap-3">
          {extUrl && (
            <button
              onClick={copyExt}
              title={`외부 접속 주소: ${extUrl}\n클릭하면 주소가 복사됩니다 (외부망·휴대폰에서 사용)`}
              className="px-2.5 py-1 text-xs font-medium border border-green-300 bg-green-50 text-green-700 hover:bg-green-100 transition whitespace-nowrap"
            >
              {copied ? "주소 복사됨!" : "🌐 외부 접속 주소"}
            </button>
          )}
          <div className="flex gap-0.5 bg-gray-100 p-0.5">
            {PROCESS_LINES.map((p) => (
              <button
                key={p}
                onClick={() => setProcessLine(p)}
                className={`px-3 py-1 text-xs font-medium transition ${
                  processLine === p
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
