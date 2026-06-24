"use client";

import { useEffect, useState } from "react";
import { PROCESS_LINES, roleCanEditLine } from "@/lib/factory-config";
import { useAuth } from "../components/AuthContext";

interface Machine {
  id: number;
  name: string;
  is_active: number;
  work_start_hour: number;
  work_end_hour: number;
  off_days: string; // 휴무 요일 JSON 배열 (0=일~6=토)
  day_hours: string; // 요일별 근무시간 오버라이드 JSON (예: {"6":[8,18]})
}

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
function parseOff(json: string | undefined): number[] {
  try { const a = JSON.parse(json || "[]"); return Array.isArray(a) ? a.map(Number).filter((n) => n >= 0 && n <= 6) : []; } catch { return []; }
}
function parseDayHoursUI(json: string | undefined): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {};
  try {
    const o = JSON.parse(json || "");
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) {
        const d = Number(k); const v = (o as Record<string, unknown>)[k];
        if (d >= 0 && d <= 6 && Array.isArray(v) && v.length === 2) out[d] = [Number(v[0]), Number(v[1])];
      }
    }
  } catch { /* 오버라이드 없음 */ }
  return out;
}
const pad2 = (n: number) => String(n).padStart(2, "0");
// 시각값(시 단위, 30분=0.5)을 "HH:MM"으로. 시작=종료(또는 종료<시작)면 24시간 가동.
const hourOf = (v: number) => Math.floor(v);
const isHalf = (v: number) => Math.round((v - Math.floor(v)) * 60) === 30;
const fmtHM = (v: number) => `${pad2(Math.floor(v))}:${pad2(Math.round((v - Math.floor(v)) * 60))}`;
const fmtHours = (s: number, e: number) => (e <= s ? "24시간" : `${fmtHM(s)}~${fmtHM(e)}`);
// 근무일들의 근무시간을 요약. 전부 같으면 "08~24시", 다르면 "월·화·수·목·금 08~24시 · 토 08~18시".
function hoursSummary(m: Machine): string {
  const off = new Set(parseOff(m.off_days));
  const dh = parseDayHoursUI(m.day_hours);
  const working = [0, 1, 2, 3, 4, 5, 6].filter((d) => !off.has(d));
  if (working.length === 0) return "";
  const hoursOf = (d: number): [number, number] => dh[d] ?? [Number(m.work_start_hour), Number(m.work_end_hour)];
  const groups: { key: string; days: number[] }[] = [];
  for (const d of working) {
    const [s, e] = hoursOf(d); const key = fmtHours(s, e);
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, days: [] }; groups.push(g); }
    g.days.push(d);
  }
  if (groups.length === 1) return groups[0].key;
  return groups.map((g) => `${g.days.map((d) => DAY_LABELS[d]).join("·")} ${g.key}`).join(" · ");
}

// 공정 라인 하나의 설비 목록 열. 추가/수정/삭제/드래그 순서변경을 모두 이 라인 안에서 처리한다.
function MachineColumn({ processLine, isAdmin }: { processLine: string; isAdmin: boolean }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  // 요일별(0=일~6=토) 근무 설정: 휴무 여부 + 근무 시작/종료 시
  const [editDays, setEditDays] = useState<{ off: boolean; start: number; end: number }[]>([]);
  // 일괄 적용용 시작/종료(시, 30분=.5)
  const [editBulkStart, setEditBulkStart] = useState(8);
  const [editBulkEnd, setEditBulkEnd] = useState(22);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // 삽입 슬롯: 0=맨 위, n=맨 아래 (행 i 앞 = i)
  const [overSlot, setOverSlot] = useState<number | null>(null);

  const fetchMachines = async () => {
    const res = await fetch(`/api/machines?process_line=${encodeURIComponent(processLine)}`);
    setMachines(await res.json());
  };

  useEffect(() => {
    fetchMachines();
  }, [processLine]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    await fetch("/api/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, process_line: processLine }),
    });
    setName("");
    await fetchMachines();
    setLoading(false);
  };

  // 설비의 저장값에서 요일별 편집 상태를 만든다(편집 시작·다른 설비 복사 공용).
  const daysFromMachine = (m: Machine) => {
    const off = new Set(parseOff(m.off_days));
    const dh = parseDayHoursUI(m.day_hours);
    // 0시(자정)는 falsy라 || 로 기본값 처리하면 8시로 바뀐다 → 유한수면 그대로 사용.
    const defS = Number.isFinite(Number(m.work_start_hour)) ? Number(m.work_start_hour) : 8;
    const defE = Number.isFinite(Number(m.work_end_hour)) ? Number(m.work_end_hour) : 22;
    return DAY_LABELS.map((_, d) => {
      const ov = dh[d];
      return { off: off.has(d), start: ov ? ov[0] : defS, end: ov ? ov[1] : defE };
    });
  };

  const startEdit = (m: Machine) => {
    setEditingId(m.id);
    setEditName(m.name);
    const days = daysFromMachine(m);
    setEditDays(days);
    const fw = days.find((c) => !c.off);
    setEditBulkStart(fw ? fw.start : 8);
    setEditBulkEnd(fw ? fw.end : 22);
  };

  // 일괄: 시작/종료를 정해 모든 요일(근무일)에 한 번에 적용. 휴무 여부는 그대로 둔다.
  const setBulkTime = (which: "start" | "end", hr: number, half: boolean) => {
    let v = Math.min(Math.max(Number.isFinite(hr) ? hr : 0, 0), 24);
    if (v < 24 && half) v += 0.5;
    if (which === "start") setEditBulkStart(v); else setEditBulkEnd(v);
  };
  const applyBulkToAll = () => {
    setEditDays((prev) => prev.map((c) => ({ ...c, start: editBulkStart, end: editBulkEnd })));
  };
  // 다른 설비의 근무 패턴(휴무·요일별 시간)을 통째로 가져온다(저장 전까지는 편집 상태만 변경).
  const copyFromMachine = (id: number) => {
    const m2 = machines.find((x) => x.id === id);
    if (!m2) return;
    const days = daysFromMachine(m2);
    setEditDays(days);
    const fw = days.find((c) => !c.off);
    setEditBulkStart(fw ? fw.start : 8);
    setEditBulkEnd(fw ? fw.end : 22);
  };

  // 요일 토글: 휴무↔근무. 7요일 전부 휴무(전체 휴무 설비)도 허용.
  const toggleOff = (day: number) => {
    setEditDays((prev) => prev.map((c, d) => (d === day ? { ...c, off: !c.off } : c)));
  };
  // 요일별 시각 설정(시 + 30분 여부). 24시엔 :30 없음.
  const setDayTime = (day: number, key: "start" | "end", hr: number, half: boolean) => {
    let val = Math.min(Math.max(Number.isFinite(hr) ? hr : 0, 0), 24);
    if (val < 24 && half) val += 0.5;
    setEditDays((prev) => prev.map((c, d) => (d === day ? { ...c, [key]: val } : c)));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  const saveEdit = async (m: Machine) => {
    const trimmed = editName.trim();
    if (!trimmed) { cancelEdit(); return; }
    const clamp = (n: number) => Math.min(Math.max(Number.isFinite(n) ? n : 0, 0), 24);
    const offSorted = editDays.map((c, d) => (c.off ? d : -1)).filter((d) => d >= 0);
    // 근무일별 시간 정규화: 종료<=시작이면(예: 8~8) 24시간 가동(0~24)으로.
    const norm = editDays
      .map((c, d) => ({ d, ...c }))
      .filter((c) => !c.off)
      .map((c) => { let s = clamp(c.start), e = clamp(c.end); if (e <= s) { s = 0; e = 24; } return { d: c.d, s, e }; });
    // 모든 근무일이 같은 시간이면 오버라이드 없이 기본 work_start/end만 저장. 다르면 day_hours에 요일별로.
    // 단, 30분 단위(.5) 값이 있으면 INTEGER 컬럼 반올림 손실을 막기 위해 day_hours(JSON)에 보관한다.
    let work_start_hour = 8, work_end_hour = 22;
    const day_hours: Record<number, [number, number]> = {};
    if (norm.length > 0) {
      work_start_hour = Math.floor(norm[0].s);
      work_end_hour = Math.ceil(norm[0].e);
      const uniform = norm.every((n) => n.s === norm[0].s && n.e === norm[0].e);
      const anyHalf = norm.some((n) => isHalf(n.s) || isHalf(n.e));
      if (!uniform || anyHalf) for (const n of norm) day_hours[n.d] = [n.s, n.e];
    }
    setLoading(true);
    await fetch(`/api/machines/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, work_start_hour, work_end_hour, off_days: offSorted, day_hours }),
    });
    cancelEdit();
    await fetchMachines();
    setLoading(false);
  };

  // 드래그한 설비(from)를 삽입 슬롯(slot: 0~n)으로 옮기고 순서를 저장 (이 라인 안에서만)
  const reorderTo = async (from: number, slot: number) => {
    if (from == null || slot == null) return;
    const reordered = [...machines];
    const [moved] = reordered.splice(from, 1);
    const adj = slot > from ? slot - 1 : slot; // 제거로 인덱스가 당겨진 만큼 보정
    reordered.splice(adj, 0, moved);
    // 순서 변화가 없으면 아무것도 안 함
    if (reordered.every((m, i) => m.id === machines[i].id)) return;
    setMachines(reordered); // 즉시 반영
    setLoading(true);
    await fetch("/api/machines/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: reordered.map((m) => m.id) }),
    });
    await fetchMachines();
    setLoading(false);
  };

  const handleDelete = async (m: Machine) => {
    if (!window.confirm(`'${m.name}' 설비를 삭제하시겠습니까?\n이 설비에 배정된 작업도 함께 삭제됩니다.`)) return;
    setLoading(true);
    await fetch(`/api/machines/${m.id}`, { method: "DELETE" });
    await fetchMachines();
    setLoading(false);
  };

  return (
    <div className="flex-1 min-w-[280px]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-gray-900">
          {processLine} 라인{!isAdmin && <span className="ml-1 text-xs font-normal text-gray-400">(보기 전용)</span>}
        </h3>
        <span className="text-xs text-gray-400">{machines.length}대</span>
      </div>

      {isAdmin && (
        <form onSubmit={handleAdd} className="flex gap-2 mb-3">
          <input
            type="text"
            placeholder={`${processLine} 설비명 입력`}
            className="flex-1 min-w-0 border px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            추가
          </button>
        </form>
      )}

      <div className="bg-white border shadow-sm divide-y">
        {machines.length === 0 ? (
          <div className="px-4 py-6 text-center text-gray-400 text-sm">등록된 설비가 없습니다.</div>
        ) : (
          machines.map((m, index) => (
            <div
              key={m.id}
              draggable={isAdmin && editingId === null}
              onDragStart={(e) => {
                if (!isAdmin || editingId !== null) return;
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                // 커서가 행의 위/아래 절반 중 어디인지로 삽입 슬롯 결정
                const rect = e.currentTarget.getBoundingClientRect();
                const slot = e.clientY > rect.top + rect.height / 2 ? index + 1 : index;
                if (overSlot !== slot) setOverSlot(slot);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragIndex !== null && overSlot !== null) reorderTo(dragIndex, overSlot);
                setDragIndex(null);
                setOverSlot(null);
              }}
              onDragEnd={() => { setDragIndex(null); setOverSlot(null); }}
              className={`flex items-center justify-between px-4 py-2.5 gap-2 ${
                isAdmin && editingId === null ? "cursor-grab active:cursor-grabbing" : ""
              } ${dragIndex === index ? "opacity-40" : ""} ${
                overSlot === index ? "border-t-2 border-t-blue-500" : ""
              } ${
                index === machines.length - 1 && overSlot === machines.length ? "border-b-2 border-b-blue-500" : ""
              }`}
            >
              {isAdmin && <span className="text-gray-300 shrink-0 select-none" title="드래그하여 순서 변경">⠿</span>}
              {editingId === m.id ? (
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    className="w-full border px-2 py-1 text-sm"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEdit(m);
                      if (e.key === "Escape") cancelEdit();
                    }}
                  />
                  {/* 일괄 적용 + 다른 설비 복사: 매번 7일을 따로 만지지 않도록 */}
                  <div className="flex flex-wrap items-center gap-1 bg-gray-50 border px-2 py-1.5">
                    <span className="text-[11px] text-gray-500 mr-0.5">일괄</span>
                    <input
                      type="number" min="0" max="24"
                      className="w-10 border px-1 py-0.5 text-sm text-center"
                      value={hourOf(editBulkStart)}
                      onChange={(e) => setBulkTime("start", Number(e.target.value), isHalf(editBulkStart))}
                      title="일괄 시작 시"
                    />
                    <button type="button" onClick={() => setBulkTime("start", hourOf(editBulkStart), !isHalf(editBulkStart))} className="w-9 h-7 text-xs border bg-white hover:bg-gray-100">{isHalf(editBulkStart) ? ":30" : ":00"}</button>
                    <span className="text-gray-400">~</span>
                    <input
                      type="number" min="0" max="24"
                      className="w-10 border px-1 py-0.5 text-sm text-center"
                      value={hourOf(editBulkEnd)}
                      onChange={(e) => setBulkTime("end", Number(e.target.value), isHalf(editBulkEnd))}
                      title="일괄 종료 시"
                    />
                    <button type="button" onClick={() => setBulkTime("end", hourOf(editBulkEnd), !isHalf(editBulkEnd))} className="w-9 h-7 text-xs border bg-white hover:bg-gray-100">{isHalf(editBulkEnd) ? ":30" : ":00"}</button>
                    <button type="button" onClick={applyBulkToAll} className="h-7 px-2 text-xs border bg-blue-600 text-white hover:bg-blue-700">전체 적용</button>
                    {machines.filter((x) => x.id !== m.id).length > 0 && (
                      <select
                        className="h-7 border text-xs px-1 ml-auto"
                        value=""
                        onChange={(e) => { if (e.target.value) copyFromMachine(Number(e.target.value)); }}
                        title="다른 설비의 근무 패턴(휴무·요일별 시간) 가져오기"
                      >
                        <option value="">설비에서 복사</option>
                        {machines.filter((x) => x.id !== m.id).map((x) => (
                          <option key={x.id} value={x.id}>{x.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500">요일별 근무시간 (요일 클릭=근무↔휴무)</div>
                  <div className="flex flex-col gap-1">
                    {DAY_LABELS.map((d, i) => {
                      const cfg = editDays[i] || { off: false, start: 8, end: 22 };
                      return (
                        <div key={i} className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => toggleOff(i)}
                            className={`w-7 h-7 text-xs border ${cfg.off ? "bg-gray-100 text-gray-300 line-through border-gray-200" : "bg-blue-50 text-blue-700 border-blue-300 font-medium"}`}
                            title={cfg.off ? `${d}요일 휴무 (클릭=근무)` : `${d}요일 근무 (클릭=휴무)`}
                          >
                            {d}
                          </button>
                          {cfg.off ? (
                            <span className="text-[11px] text-gray-400">휴무</span>
                          ) : (
                            <>
                              <input
                                type="number" min="0" max="24"
                                className="w-11 border px-1 py-0.5 text-sm text-center"
                                value={hourOf(cfg.start)}
                                onChange={(e) => setDayTime(i, "start", Number(e.target.value), isHalf(cfg.start))}
                                title={`${d}요일 근무 시작 시`}
                              />
                              <button
                                type="button"
                                onClick={() => setDayTime(i, "start", hourOf(cfg.start), !isHalf(cfg.start))}
                                className="w-9 h-7 text-xs border bg-white hover:bg-gray-50"
                                title={`${d}요일 시작 분 (:00↔:30)`}
                              >
                                {isHalf(cfg.start) ? ":30" : ":00"}
                              </button>
                              <span className="text-gray-400">~</span>
                              <input
                                type="number" min="0" max="24"
                                className="w-11 border px-1 py-0.5 text-sm text-center"
                                value={hourOf(cfg.end)}
                                onChange={(e) => setDayTime(i, "end", Number(e.target.value), isHalf(cfg.end))}
                                title={`${d}요일 근무 종료 시`}
                              />
                              <button
                                type="button"
                                onClick={() => setDayTime(i, "end", hourOf(cfg.end), !isHalf(cfg.end))}
                                className="w-9 h-7 text-xs border bg-white hover:bg-gray-50"
                                title={`${d}요일 종료 분 (:00↔:30)`}
                              >
                                {isHalf(cfg.end) ? ":30" : ":00"}
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[10px] text-gray-400">시작=종료로 두면 24시간 가동 · :00/:30 버튼으로 30분 단위</div>
                </div>
              ) : (
                <span className={`flex-1 min-w-0 text-sm font-medium ${m.is_active ? "text-gray-900" : "text-gray-400"}`}>
                  {m.name}
                  {hoursSummary(m) && <span className="ml-2 text-[11px] font-normal text-gray-400">{hoursSummary(m)}</span>}
                  {parseOff(m.off_days).length >= 7 ? (
                    <span className="ml-1 text-[11px] font-normal text-red-500">· 전체 휴무</span>
                  ) : parseOff(m.off_days).length > 0 ? (
                    <span className="ml-1 text-[11px] font-normal text-orange-500">· 휴무 {parseOff(m.off_days).map((i) => DAY_LABELS[i]).join("·")}</span>
                  ) : null}
                </span>
              )}
              {isAdmin && (
              <div className="flex items-center gap-3 shrink-0">
                {editingId === m.id ? (
                  <>
                    <button
                      onClick={() => saveEdit(m)}
                      disabled={loading}
                      className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                    >
                      저장
                    </button>
                    <button
                      onClick={cancelEdit}
                      disabled={loading}
                      className="text-gray-400 hover:text-gray-600 text-sm"
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => startEdit(m)}
                      disabled={loading}
                      className="text-gray-400 hover:text-blue-600 text-sm"
                      title="이름 수정"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => handleDelete(m)}
                      disabled={loading}
                      className="text-red-400 hover:text-red-600 text-sm"
                      title="삭제"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function MachinesPage() {
  const { role } = useAuth(); // 담당 라인만 편집 가능 (열별로 권한 적용).

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-1">설비 관리</h2>
      <p className="text-sm text-gray-500 mb-6">공정 라인별로 설비를 추가·관리합니다. 담당 라인만 편집할 수 있고, 같은 라인 안에서 드래그하여 순서를 바꿀 수 있습니다.</p>

      {/* 공정 라인(매엽·윤전·무선)을 나란히 열로 배치 — 담당 라인만 편집, 그 외는 보기 전용. */}
      <div className="flex gap-6 items-start overflow-x-auto pb-2">
        {PROCESS_LINES.map((line) => (
          <MachineColumn key={line} processLine={line} isAdmin={roleCanEditLine(role, line)} />
        ))}
      </div>
    </div>
  );
}
