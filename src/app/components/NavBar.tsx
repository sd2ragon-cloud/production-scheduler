"use client";

import { PROCESS_LINES } from "@/lib/factory-config";
import { useProcess } from "./ProcessContext";

export default function NavBar() {
  const { processLine, setProcessLine } = useProcess();

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="w-full px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <a href="/" className="text-lg font-bold text-gray-900 mr-3">생산 스케줄링</a>
          <a href="/" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">대시보드</a>
          <a href="/orders" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">주문 관리</a>
          <a href="/machines" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">설비 관리</a>
          <a href="/schedule" className="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition">스케줄 보기</a>
        </div>
        <div className="flex items-center gap-3">
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
