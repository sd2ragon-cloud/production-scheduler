"use client";

import { FACTORY_PROCESS_MAP, FACTORIES } from "@/lib/factory-config";
import { useProcess } from "./ProcessContext";

export default function NavBar() {
  const { factory, processLine, switchFactory, setProcessLine } = useProcess();
  const processes = FACTORY_PROCESS_MAP[factory] || [];

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <a href="/" className="text-lg font-bold text-gray-900 mr-3">생산 스케줄링</a>
          <a href="/" className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition">대시보드</a>
          <a href="/orders" className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition">주문 관리</a>
          <a href="/machines" className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition">기계 관리</a>
          <a href="/schedule" className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition">스케줄 보기</a>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
            {FACTORIES.map((f) => (
              <button
                key={f}
                onClick={() => switchFactory(f)}
                className={`px-3 py-1 rounded-md text-xs font-bold transition ${
                  factory === f
                    ? "bg-gray-800 text-white"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <span className="text-gray-300">|</span>
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
            {processes.map((p) => (
              <button
                key={p}
                onClick={() => setProcessLine(p)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${
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
