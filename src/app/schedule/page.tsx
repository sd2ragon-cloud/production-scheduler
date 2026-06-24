"use client";

import { useEffect, useState } from "react";
import { useProcess } from "../components/ProcessContext";

interface ScheduleEntry {
  id: number;
  machine_name: string;
  machine_id: number;
  product_name: string;
  component: string;
  component_part: string;
  quantity_sheets: number;
  deadline: string;
  special_process: string;
  sequence: number;
  start_time: string;
  end_time: string;
  order_notes: string;
  priority: number;
}

const MACHINE_COLORS = [
  "bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500",
  "bg-cyan-500", "bg-pink-500", "bg-yellow-500",
];

// 완료시간 "MM-DD HH:MM" 표기. 정확히 자정(00:00) 완료는 전날 근무종료(24:00)로 보여 휴무 다음날 표기를 피한다.
function formatEndShort(endTimeStr: string): string {
  const dt = new Date(endTimeStr);
  if (!isNaN(dt.getTime()) && dt.getHours() === 0 && dt.getMinutes() === 0) {
    const prev = new Date(dt.getTime() - 60000);
    const mm = String(prev.getMonth() + 1).padStart(2, "0");
    const dd = String(prev.getDate()).padStart(2, "0");
    return `${mm}-${dd} 24:00`;
  }
  return endTimeStr.slice(5, 16);
}

export default function SchedulePage() {
  const { processLine } = useProcess();
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [view, setView] = useState<"gantt" | "table">("gantt");

  useEffect(() => {
    const qs = `?process_line=${encodeURIComponent(processLine)}`;
    fetch(`/api/schedule${qs}`)
      .then((r) => r.json())
      .then(setEntries);
  }, [processLine]);

  const machines = Array.from(new Set(entries.map((e) => e.machine_name)));

  const allTimes = entries.flatMap((e) => [new Date(e.start_time).getTime(), new Date(e.end_time).getTime()]);
  const minTime = allTimes.length > 0 ? Math.min(...allTimes) : Date.now();
  const maxTime = allTimes.length > 0 ? Math.max(...allTimes) : Date.now() + 86400000;
  const totalSpan = maxTime - minTime || 1;

  const getDayLabels = () => {
    const labels: { label: string; left: number }[] = [];
    const start = new Date(minTime);
    start.setHours(0, 0, 0, 0);
    const end = new Date(maxTime);

    const current = new Date(start);
    while (current <= end) {
      const pos = ((current.getTime() - minTime) / totalSpan) * 100;
      if (pos >= 0 && pos <= 100) {
        const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
        labels.push({
          label: `${current.getMonth() + 1}/${current.getDate()}(${dayNames[current.getDay()]})`,
          left: pos,
        });
      }
      current.setDate(current.getDate() + 1);
    }
    return labels;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">스케줄 보기</h2>
        <div className="flex gap-1 bg-gray-100 p-1">
          <button
            onClick={() => setView("gantt")}
            className={`px-4 py-1.5 text-sm font-medium transition ${view === "gantt" ? "bg-white shadow text-gray-900" : "text-gray-500"}`}
          >
            간트차트
          </button>
          <button
            onClick={() => setView("table")}
            className={`px-4 py-1.5 text-sm font-medium transition ${view === "table" ? "bg-white shadow text-gray-900" : "text-gray-500"}`}
          >
            테이블
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="bg-white p-12 text-center shadow-sm border">
          <p className="text-gray-500 text-lg">생성된 스케줄이 없습니다.</p>
          <p className="text-gray-400 text-sm mt-2">대시보드에서 스케줄을 생성해주세요.</p>
        </div>
      ) : view === "gantt" ? (
        <div className="bg-white shadow-sm border p-6">
          <div className="relative">
            <div className="relative h-8 mb-2 border-b">
              {getDayLabels().map((d, i) => (
                <div
                  key={i}
                  className="absolute text-xs text-gray-500 font-medium"
                  style={{ left: `${Math.max(0, d.left)}%` }}
                >
                  {d.label}
                </div>
              ))}
            </div>

            {machines.map((machineName, mi) => {
              const machineEntries = entries
                .filter((e) => e.machine_name === machineName)
                .sort((a, b) => a.sequence - b.sequence);

              return (
                <div key={machineName} className="flex items-center mb-2">
                  <div className="w-20 text-sm font-bold text-gray-700 shrink-0">{machineName}</div>
                  <div className="flex-1 relative h-10 bg-gray-50 border">
                    {machineEntries.map((entry) => {
                      const start = new Date(entry.start_time).getTime();
                      const end = new Date(entry.end_time).getTime();
                      const left = ((start - minTime) / totalSpan) * 100;
                      const width = Math.max(((end - start) / totalSpan) * 100, 0.5);
                      const isOverDeadline = new Date(entry.end_time) > new Date(entry.deadline);

                      return (
                        <div
                          key={entry.id}
                          className={`absolute top-1 h-8 text-xs text-white flex items-center px-1 overflow-hidden cursor-default ${
                            isOverDeadline ? "bg-red-500" : MACHINE_COLORS[mi % MACHINE_COLORS.length]
                          }`}
                          style={{ left: `${left}%`, width: `${width}%`, minWidth: "4px" }}
                          title={`${entry.product_name}(${entry.component_part || entry.component}) - ${entry.quantity_sheets}매\n시작: ${entry.start_time}\n완료: ${entry.end_time}\n납기: ${entry.deadline}`}
                        >
                          <span className="truncate">{entry.product_name}({entry.component_part || entry.component})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 bg-red-500 inline-block"></span> 납기 초과
            </span>
            {machines.map((m, i) => (
              <span key={m} className="flex items-center gap-1">
                <span className={`w-3 h-3 ${MACHINE_COLORS[i % MACHINE_COLORS.length]} inline-block`}></span>
                {m}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-left">
                <th className="px-3 py-2">기계</th>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">작업명</th>
                <th className="px-3 py-2">수량</th>
                <th className="px-3 py-2">공정</th>
                <th className="px-3 py-2">시작</th>
                <th className="px-3 py-2">완료</th>
                <th className="px-3 py-2">납기</th>
                <th className="px-3 py-2">상태</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isOver = new Date(entry.end_time) > new Date(entry.deadline);
                return (
                  <tr key={entry.id} className={`border-t ${isOver ? "bg-red-50" : "hover:bg-gray-50"}`}>
                    <td className="px-3 py-2 font-bold">{entry.machine_name}</td>
                    <td className="px-3 py-2 text-gray-400">{entry.sequence}</td>
                    <td className="px-3 py-2">
                      {entry.product_name} <span className="text-gray-500">({entry.component_part || entry.component})</span>
                    </td>
                    <td className="px-3 py-2">{entry.quantity_sheets}</td>
                    <td className="px-3 py-2">{entry.special_process}</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.start_time.slice(5, 16)}</td>
                    <td className={`px-3 py-2 font-mono text-xs ${isOver ? "text-red-600 font-bold" : ""}`}>
                      {formatEndShort(entry.end_time)}
                    </td>
                    <td className="px-3 py-2 text-xs">{entry.deadline.slice(5)}</td>
                    <td className="px-3 py-2">
                      {isOver ? (
                        <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-medium">납기초과</span>
                      ) : (
                        <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium">정상</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
