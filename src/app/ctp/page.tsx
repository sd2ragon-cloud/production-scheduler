"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../components/AuthContext";

// CTP(판 출력) 전용 화면.
// 매엽·윤전 전 설비의 작업을 '작업 시작 시각' 순으로 한 줄로 보여주고, 판 필요 시각(시작 - 준비시간)을 표시한다.
// 자동 새로고침되며, 매엽·윤전에서 순서가 바뀌어 시작이 앞당겨진 작업은 알림(노란 줄 + 상단 배너 + 알림음)으로 표시한다.

interface PlateEntry {
  id: number;
  machine_id: number;
  sequence: number;
  start_time: string;
  end_time: string;
  component_part: string;
  plate_done_at: string;
  plate_done_by: string;
  changed_at: string;
  change_note: string;
  product_name: string;
  quantity: number;
  notes: string;
  machine_name: string;
  process_line: string;
}

const REFRESH_MS = 20_000;          // 자동 새로고침 주기
const CHANGE_KEEP_MS = 12 * 3600e3; // 변경 알림을 보여주는 기간
const SOON_MS = 60 * 60e3;          // 판 필요 시각까지 이 시간 이내면 '임박'
const LS_SEEN = "ctp:lastSeenChange";
const LS_FILTER = "ctp:filter";
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

function toMs(s: string): number {
  return s ? new Date(s.replace(" ", "T")).getTime() : NaN;
}
function hm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayLabel(key: string, todayKey: string): string {
  if (!key) return "일정 미정";
  const d = new Date(key + "T00:00:00");
  const base = `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
  const diff = Math.round((d.getTime() - new Date(todayKey + "T00:00:00").getTime()) / 86400e3);
  return diff === 0 ? `${base} 오늘` : diff === 1 ? `${base} 내일` : base;
}
function lsGet(k: string): string {
  try { return localStorage.getItem(k) || ""; } catch { return ""; }
}
function lsSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경은 무시 */ }
}
function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.35].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* 소리 재생 불가(브라우저 정책 등)는 무시 */ }
}

export default function CtpPage() {
  const { role } = useAuth();
  const canCheck = role === "ctp" || role === "sheet";
  const [entries, setEntries] = useState<PlateEntry[]>([]);
  const [leadMin, setLeadMin] = useState(30);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [now, setNow] = useState(0); // 서버 렌더와 어긋나지 않게 마운트 후(첫 조회 시) 채운다
  const [lastSeen, setLastSeen] = useState("");
  const [line, setLine] = useState("all");
  const [machine, setMachine] = useState("all");
  const [hideDone, setHideDone] = useState(true);
  const [busy, setBusy] = useState(false);
  const alertCountRef = useRef(0);

  // 필터·확인 기록 복원(PC별)
  useEffect(() => {
    setLastSeen(lsGet(LS_SEEN));
    try {
      const f = JSON.parse(lsGet(LS_FILTER) || "{}");
      if (typeof f.line === "string") setLine(f.line);
      if (typeof f.machine === "string") setMachine(f.machine);
      if (typeof f.hideDone === "boolean") setHideDone(f.hideDone);
    } catch { /* 무시 */ }
  }, []);
  useEffect(() => { lsSet(LS_FILTER, JSON.stringify({ line, machine, hideDone })); }, [line, machine, hideDone]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/plates", { cache: "no-store" });
      if (!r.ok) throw new Error();
      const d = await r.json();
      setEntries(Array.isArray(d.entries) ? d.entries : []);
      if (Number(d.lead_min) > 0) setLeadMin(Number(d.lead_min));
      setUpdatedAt(Date.now());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
      setNow(Date.now());
    }
  }, []);

  // 자동 새로고침 + 화면으로 돌아오면 즉시 갱신
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [load]);

  const leadMs = leadMin * 60e3;

  // 최근 변경 중 판이 아직 출력되지 않은 것. (이미 출력된 판은 시작만 당겨져도 문제없음.
  //  다른 설비로 이동·구성 추가처럼 판을 다시 봐야 하는 변경은 서버가 출력완료를 해제한다)
  const isUnhandled = useCallback((e: PlateEntry) => {
    if (!e.changed_at || e.plate_done_at) return false;
    return now - toMs(e.changed_at) <= CHANGE_KEEP_MS;
  }, [now]);

  const alerts = useMemo(
    () => entries.filter((e) => isUnhandled(e) && e.changed_at > lastSeen).sort((a, b) => a.start_time.localeCompare(b.start_time)),
    [entries, isUnhandled, lastSeen],
  );

  // 새 변경이 생기면 알림음
  useEffect(() => {
    if (alerts.length > alertCountRef.current) beep();
    alertCountRef.current = alerts.length;
  }, [alerts.length]);

  const ackAlerts = () => {
    const max = entries.reduce((m, e) => (e.changed_at > m ? e.changed_at : m), lastSeen);
    setLastSeen(max);
    lsSet(LS_SEEN, max);
  };

  const machines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) if (!seen.has(e.machine_name)) seen.set(e.machine_name, e.process_line);
    return Array.from(seen.entries()).filter(([, l]) => line === "all" || l === line).map(([n]) => n);
  }, [entries, line]);

  const visible = useMemo(() => entries.filter((e) =>
    (line === "all" || e.process_line === line) &&
    (machine === "all" || e.machine_name === machine) &&
    (!hideDone || !e.plate_done_at || isUnhandled(e)),
  ), [entries, line, machine, hideDone, isUnhandled]);

  const groups = useMemo(() => {
    const out: { key: string; rows: PlateEntry[] }[] = [];
    for (const e of visible) {
      const t = toMs(e.start_time);
      const key = Number.isFinite(t) ? dayKey(t) : "";
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push(e);
      else out.push({ key, rows: [e] });
    }
    return out;
  }, [visible]);

  const todayKey = dayKey(now);
  const overdue = entries.filter((e) => !e.plate_done_at && Number.isFinite(toMs(e.start_time)) && toMs(e.start_time) <= now);

  const setDone = async (ids: number[], done: boolean) => {
    if (!canCheck || ids.length === 0) return;
    setBusy(true);
    // 낙관적 갱신(서버와 같은 'YYYY-MM-DD HH:MM:SS' 로컬 시각)
    const n = new Date();
    const p = (x: number) => String(x).padStart(2, "0");
    const stamp = done ? `${dayKey(n.getTime())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}` : "";
    setEntries((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, plate_done_at: stamp, plate_done_by: "" } : e)));
    try {
      const r = await fetch("/api/plates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_ids: ids, done }),
      });
      if (!r.ok) alert((await r.json().catch(() => ({}))).error || "저장하지 못했습니다.");
    } finally {
      await load();
      setBusy(false);
    }
  };

  const status = (e: PlateEntry): { text: string; cls: string } => {
    if (e.plate_done_at) {
      return { text: `✓ 출력완료 ${e.plate_done_at.slice(11, 16)}`, cls: "bg-green-100 text-green-800 border-green-300" };
    }
    const start = toMs(e.start_time);
    if (!Number.isFinite(start)) return { text: "일정 미정", cls: "bg-gray-100 text-gray-500 border-gray-300" };
    const need = start - leadMs;
    if (now >= start) return { text: "늦음 (작업 시작됨)", cls: "bg-red-600 text-white border-red-700" };
    if (now >= need) return { text: "지금 필요", cls: "bg-red-100 text-red-700 border-red-400" };
    if (need - now <= SOON_MS) return { text: `${Math.ceil((need - now) / 60e3)}분 후 필요`, cls: "bg-orange-100 text-orange-700 border-orange-300" };
    return { text: "대기", cls: "bg-white text-gray-500 border-gray-300" };
  };

  const printStamp = new Date(updatedAt || now);

  return (
    <>
      <div className="space-y-3">
        {/* 상단: 제목·갱신 상태·필터 */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">CTP 판 출력 순서</h1>
          <span className="text-xs text-gray-500">
            매엽·윤전 전체 작업을 <b>작업 시작 시각 순</b>으로 표시 · 판 필요 시각 = 작업 시작 {leadMin}분 전
          </span>
          <span className={`text-xs px-2 py-0.5 border ${error ? "border-red-300 bg-red-50 text-red-700" : "border-gray-200 bg-white text-gray-500"}`}>
            {error ? "⚠ 서버 연결 끊김 — 화면이 최신이 아닐 수 있습니다" : `자동 갱신 중 · 마지막 ${updatedAt ? new Date(updatedAt).toLocaleTimeString("ko-KR") : "-"}`}
          </span>
          <button onClick={load} className="px-2.5 py-1 text-xs border border-gray-300 bg-white hover:bg-gray-100">⟳ 지금 새로고침</button>
          <button onClick={() => window.print()} className="px-2.5 py-1 text-xs border border-gray-300 bg-white hover:bg-gray-100">🖨 인쇄</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex gap-0.5 bg-gray-100 p-0.5">
            {["all", "매엽", "윤전"].map((l) => (
              <button key={l} onClick={() => { setLine(l); setMachine("all"); }}
                className={`px-3 py-1 font-medium ${line === l ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
                {l === "all" ? "전체" : l}
              </button>
            ))}
          </div>
          <select value={machine} onChange={(e) => setMachine(e.target.value)} className="px-2 py-1 border border-gray-300 bg-white">
            <option value="all">설비 전체</option>
            {machines.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label className="flex items-center gap-1 select-none">
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
            출력완료 숨기기
          </label>
          {!canCheck && (
            <span className="text-gray-500">※ 출력완료 체크는 우측 상단에서 <b>CTP 담당자</b>로 로그인하면 할 수 있습니다.</span>
          )}
          {canCheck && overdue.length > 0 && (
            <button
              disabled={busy}
              onClick={() => {
                if (window.confirm(`이미 작업이 시작된(시작 시각이 지난) 미출력 작업 ${overdue.length}건을 모두 '출력완료'로 체크할까요?\n(처음 사용할 때 이미 출력해 둔 판을 한 번에 정리하는 용도)`)) {
                  setDone(overdue.map((e) => e.id), true);
                }
              }}
              className="px-2.5 py-1 border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-50"
            >
              시작된 작업 {overdue.length}건 모두 출력완료 처리
            </button>
          )}
        </div>

        {/* 새 변경 알림 배너 */}
        {alerts.length > 0 && (
          <div className="border-2 border-red-400 bg-red-50 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="font-bold text-red-700">🔔 순서 변경 {alerts.length}건 — 판 출력 순서를 다시 확인하세요</div>
              <button onClick={ackAlerts} className="px-3 py-1 text-sm font-medium bg-red-600 text-white hover:bg-red-700 whitespace-nowrap">확인했음</button>
            </div>
            <ul className="mt-2 space-y-0.5 text-sm text-red-900">
              {alerts.slice(0, 10).map((e) => (
                <li key={e.id}>
                  · <b>{e.machine_name}</b> {e.product_name}{e.component_part ? ` (${e.component_part})` : ""}
                  {" — "}{e.change_note}
                  {Number.isFinite(toMs(e.start_time)) && <> · 판 필요 <b>{hm(toMs(e.start_time) - leadMs)}</b></>}
                  <span className="text-red-500"> ({e.changed_at.slice(11, 16)} 변경)</span>
                </li>
              ))}
              {alerts.length > 10 && <li>· 외 {alerts.length - 10}건</li>}
            </ul>
          </div>
        )}

        {/* 목록 */}
        {!loaded ? (
          <div className="text-sm text-gray-500">불러오는 중…</div>
        ) : groups.length === 0 ? (
          <div className="text-sm text-gray-500 border border-gray-200 bg-white p-6 text-center">표시할 작업이 없습니다.</div>
        ) : (
          <div className="overflow-x-auto border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-white text-xs">
                <tr>
                  <th className="px-2 py-1.5 text-left w-36">상태</th>
                  <th className="px-2 py-1.5 text-left w-16">판 필요</th>
                  <th className="px-2 py-1.5 text-left w-16">작업 시작</th>
                  <th className="px-2 py-1.5 text-left w-24">설비</th>
                  <th className="px-2 py-1.5 text-left">제품명</th>
                  <th className="px-2 py-1.5 text-left">구성</th>
                  <th className="px-2 py-1.5 text-right w-20">수량</th>
                  <th className="px-2 py-1.5 text-left">비고</th>
                  <th className="px-2 py-1.5 text-center w-24">판 출력</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.key || "none"} label={dayLabel(g.key, todayKey)}>
                    {g.rows.map((e) => {
                      const st = status(e);
                      const start = toMs(e.start_time);
                      const changed = isUnhandled(e);
                      return (
                        <tr key={e.id} className={`border-t border-gray-100 ${changed ? "bg-yellow-100" : e.plate_done_at ? "text-gray-400" : ""}`}>
                          <td className="px-2 py-1">
                            <span className={`inline-block px-1.5 py-0.5 text-xs font-medium border whitespace-nowrap ${st.cls}`}>{st.text}</span>
                          </td>
                          <td className="px-2 py-1 font-bold tabular-nums">{Number.isFinite(start) ? hm(start - leadMs) : "-"}</td>
                          <td className="px-2 py-1 tabular-nums">{Number.isFinite(start) ? hm(start) : "-"}</td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {e.machine_name} <span className="text-xs text-gray-400">#{e.sequence}</span>
                          </td>
                          <td className="px-2 py-1">
                            {e.product_name}
                            {changed && (
                              <div className="text-xs font-bold text-red-700">🔔 {e.change_note} <span className="font-normal">({e.changed_at.slice(11, 16)})</span></div>
                            )}
                            {!changed && e.change_note && e.changed_at && now - toMs(e.changed_at) <= CHANGE_KEEP_MS && (
                              <div className="text-xs text-gray-400">{e.change_note} ({e.changed_at.slice(11, 16)})</div>
                            )}
                          </td>
                          <td className="px-2 py-1">{e.component_part}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{Number(e.quantity) ? Number(e.quantity).toLocaleString() : ""}</td>
                          <td className="px-2 py-1 text-xs text-gray-600">{e.notes}</td>
                          <td className="px-2 py-1 text-center">
                            <button
                              disabled={!canCheck || busy}
                              onClick={() => setDone([e.id], !e.plate_done_at)}
                              title={canCheck ? (e.plate_done_at ? "클릭하면 출력완료를 취소합니다" : "판을 출력했으면 클릭") : "CTP 담당자 로그인 후 체크할 수 있습니다"}
                              className={`px-2 py-0.5 text-xs font-medium border whitespace-nowrap ${e.plate_done_at
                                ? "border-green-400 bg-green-50 text-green-700"
                                : "border-gray-400 bg-white text-gray-800"} ${canCheck ? "hover:bg-gray-100" : "opacity-60 cursor-not-allowed"}`}
                            >
                              {e.plate_done_at ? "✓ 완료" : "출력완료"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </GroupRows>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 인쇄용(화면에서는 숨김) */}
      <div className="print-area hidden" style={{ padding: "10mm" }}>
        <div style={{ fontSize: "14pt", fontWeight: 700 }}>CTP 판 출력 순서</div>
        <div style={{ fontSize: "9pt", marginBottom: "3mm" }}>
          {updatedAt ? printStamp.toLocaleString("ko-KR") : ""} 기준 · 판 필요 = 작업 시작 {leadMin}분 전 · 이후 순서 변경은 화면(/ctp)에서 확인
          {line !== "all" ? ` · ${line}` : ""}{machine !== "all" ? ` · ${machine}` : ""}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "9pt" }}>
          <thead>
            <tr>
              {["판 필요", "시작", "설비", "제품명", "구성", "수량", "판 출력"].map((h) => (
                <th key={h} style={{ border: "1px solid #000", padding: "1mm 1.5mm", textAlign: "left", background: "#eee" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              <tr key={`d-${g.key}`}>
                <td colSpan={7} style={{ border: "1px solid #000", padding: "1mm 1.5mm", fontWeight: 700, background: "#f6f6f6" }}>{dayLabel(g.key, todayKey)}</td>
              </tr>,
              ...g.rows.map((e) => {
                const start = toMs(e.start_time);
                return (
                  <tr key={e.id}>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm", fontWeight: 700 }}>{Number.isFinite(start) ? hm(start - leadMs) : "-"}</td>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm" }}>{Number.isFinite(start) ? hm(start) : "-"}</td>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm" }}>{e.machine_name}</td>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm" }}>{e.product_name}</td>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm" }}>{e.component_part}</td>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm", textAlign: "right" }}>{Number(e.quantity) ? Number(e.quantity).toLocaleString() : ""}</td>
                    <td style={{ border: "1px solid #000", padding: "1mm 1.5mm", width: "18mm" }}>{e.plate_done_at ? "✓" : ""}</td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GroupRows({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="bg-gray-100">
        <td colSpan={9} className="px-2 py-1 text-xs font-bold text-gray-700">{label}</td>
      </tr>
      {children}
    </>
  );
}
