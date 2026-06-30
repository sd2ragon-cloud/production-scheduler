"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useProcess } from "./components/ProcessContext";
import { useAuth } from "./components/AuthContext";
import { parseParts, parsePartDurations, parsePartProcesses, partTotals, parsePartBuckets } from "@/lib/parts";
import { isDoubleSided } from "@/lib/print";
import { roleCanEditLine } from "@/lib/factory-config";

interface Machine {
  id: number;
  name: string;
  description: string;
  speed_sheets_per_hour: number;
  setup_time_minutes: number;
  capabilities: string;
  is_active: number;
  work_start_hour: number;
  schedule_start_time: string;
  memo: string;
  extra_notes: string; // 설비 블록 하단 기타사항 (제책)
  off_days?: string; // 휴무 요일 JSON 배열 (0=일~6=토)
}

interface Order {
  id: number;
  order_code: string;
  product_name: string;
  component: string;
  quantity_sheets: number;
  deadline: string;
  special_process: string;
  priority: number;
  notes: string;
  extra_notes: string; // 기타사항 (제책 등)
  status: string;
  duration_minutes: number;
  part_durations: string;
  part_processes: string;
  part_quantities: string; // 윤전: 구성별 수량(부) JSON {"표지": 5000, ...}
  bucket_id: number | null;
  part_buckets: string; // 구성별 1차 배정 칸 매핑 JSON {"표지": 3, ...}
}

interface Bucket {
  id: number;
  name: string;
  process_line: string;
  sort_order: number;
}

// 식사·휴게 시간 (자정 기준 분 단위). 예상완료시간 계산에서 제외된다.
interface Break {
  id: number;
  name: string;
  start_min: number;
  end_min: number;
}

interface Downtime {
  id: number;
  machine_id: number;
  start_time: string; // "YYYY-MM-DD HH:MM"
  end_time: string;
  reason: string;
}

// 분(자정 기준) ↔ "HH:MM" 변환
const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hhmmToMin = (s: string) => { const [h, m] = s.split(":").map(Number); return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m); };

interface ScheduleEntry {
  id: number;
  order_id: number;
  machine_id: number;
  machine_name: string;
  product_name: string;
  component: string;
  component_part: string;
  part_durations: string;
  part_processes: string;
  print_mode: string;
  base_minutes: number;
  quantity_sheets: number;
  deadline: string;
  special_process: string;
  priority: number;
  order_notes: string;
  order_extra: string; // 기타사항 (제책 등)
  sequence: number;
  duration_minutes: number;
  start_time: string;
  end_time: string;
  mark_color?: string; // 관리자가 #번호 클릭으로 칠하는 표시 색상(여러 관리자 공유)
}

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

// #번호 클릭 시 표시 색상 토글(없음 ↔ 노랑). 여러 관리자가 수정 표시를 공유. ''=표시 없음.
// rose(핑크)는 이동·수정 시 자동으로 칠해진다(관리자가 옮긴 것 식별용).
const MARK_CYCLE = ["", "amber"];
const MARK_BG: Record<string, string> = {
  amber: "#fde68a", // 노랑(# 클릭 수동)
  rose: "#fbcfe8",  // 핑크(이동·수정 자동)
};

// 제책 설비 하단 기타사항: 요일별(월~금) + 공통. extra_notes 컬럼에 JSON으로 저장.
const EXTRA_DAYS: [string, string][] = [["mon", "월"], ["tue", "화"], ["wed", "수"], ["thu", "목"], ["fri", "금"], ["sat", "토"], ["sun", "일"]];
// getDay()(0=일~6=토) → 기타사항 키
const WD_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// 저장값을 {mon,tue,...,general} 형태로 파싱. 구버전 단일 텍스트는 공통(general)으로 본다.
function parseExtraNotes(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : { general: raw };
  } catch {
    return { general: raw };
  }
}

const PROCESS_COLORS: Record<string, string> = {
  "일반": "bg-blue-100 text-blue-800 border-blue-200",
  "항바니쉬": "bg-purple-100 text-purple-800 border-purple-200",
  "UV": "bg-amber-100 text-amber-800 border-amber-200",
  "IR코팅": "bg-green-100 text-green-800 border-green-200",
  "양면": "bg-cyan-100 text-cyan-800 border-cyan-200",
  "패키지": "bg-orange-100 text-orange-800 border-orange-200",
  // 제책 구분
  "무선": "bg-indigo-100 text-indigo-800 border-indigo-200",
  "낙정": "bg-rose-100 text-rose-800 border-rose-200",
  "배접": "bg-teal-100 text-teal-800 border-teal-200",
};
// 제책 배정 대기 구분(공정 종류). special_process 컬럼을 재활용해 저장한다.
const JECHAE_CATS = ["무선", "낙정", "배접"] as const;

// 파트 목록의 구분(공정)을 중복 없이 구한다. 파트별 지정이 없으면 주문 기본 구분(fallback) 사용.
function processesForParts(parts: string[], partProcessesJson: string, fallback: string): string[] {
  const pp = parsePartProcesses(partProcessesJson);
  if (parts.length === 0) return [fallback];
  const seen: string[] = [];
  for (const p of parts) {
    const proc = pp[p] || fallback;
    if (!seen.includes(proc)) seen.push(proc);
  }
  return seen.length > 0 ? seen : [fallback];
}

// "MM/DD(요일) HH:MM" — 일자·요일·시간 (모든 라인 공통).
function formatEndTime(endTimeStr: string): string {
  const dt = new Date(endTimeStr);
  if (isNaN(dt.getTime())) return "-";
  const p2 = (n: number) => String(n).padStart(2, "0");
  const head = (d: Date) => `${p2(d.getMonth() + 1)}/${p2(d.getDate())}(${DAY_NAMES[d.getDay()]})`;
  // 정확히 자정(00:00)에 끝난 작업은 전날 근무종료(24:00)에 끝난 것 → 전일 기준으로.
  if (dt.getHours() === 0 && dt.getMinutes() === 0) {
    const prev = new Date(dt.getTime() - 60000);
    return `${head(prev)} 24:00`;
  }
  return `${head(dt)} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
}

export default function ScheduleBoard() {
  const { processLine } = useProcess();
  const { role } = useAuth();
  // 담당 라인만 편집 가능. 현재 보고 있는 공정 라인을 편집할 권한이 없으면 보기 전용(편집 UI 숨김).
  const isAdmin = roleCanEditLine(role, processLine);
  // 윤전 라인은 매엽과 별도로 운영: '구분(공정)' 대신 '수량(부)'을 입력·표기한다.
  const isRoll = processLine === "윤전";
  // 제책 라인은 1차 배정 칸을 쓰지 않고 기계별 작업 계획을 넓게 운영한다.
  const isJechae = processLine === "제책";
  // 윤전·제책은 '구분(공정)' 대신 수량을 입력·표기한다. 윤전=수량(부), 제책=부수.
  const usesQuantity = isRoll || isJechae;
  const qtyLabel = isJechae ? "부수" : "수량";
  // 제책: 부수 ÷ 생산성(부/시간) = 소요시간(시간). 정수로 반올림(소요시간 입력칸은 정수 단위).
  const calcDurationHours = (qty: number, prod: number): number | null =>
    prod > 0 && qty > 0 ? Math.round(qty / prod) : null;
  const [machines, setMachines] = useState<Machine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  // 전체 주문(대기·배정 완료 포함). 설비에 배정된 작업의 사양 편집에 사용.
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [breaks, setBreaks] = useState<Break[]>([]);
  const [showBreaks, setShowBreaks] = useState(false);
  // 설비별 비가동시간(설비고장·교육훈련 등)
  const [downtimes, setDowntimes] = useState<Downtime[]>([]);
  const [dtModalMachine, setDtModalMachine] = useState<number | null>(null);
  const [dtForm, setDtForm] = useState({ start: "", end: "", reason: "" });
  const [dragOrderId, setDragOrderId] = useState<number | null>(null);
  const [dragPart, setDragPart] = useState<string>("");
  const [dragEntryId, setDragEntryId] = useState<number | null>(null);
  const [dragSplit, setDragSplit] = useState<{ entryId: number; part: string } | null>(null);
  const [dragAll, setDragAll] = useState(false);
  // 1차 배정(칸) 드롭 시 어떤 구성을 옮길지. 빈 배열 = 구성 없는 주문(전체를 bucket_id로).
  const [dragParts, setDragParts] = useState<string[]>([]);
  const [waitingDrop, setWaitingDrop] = useState(false);
  const [partReorderTarget, setPartReorderTarget] = useState<{ part: string; after: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [dropBucket, setDropBucket] = useState<number | null>(null);
  const [manageBuckets, setManageBuckets] = useState(false);
  const [reorderTarget, setReorderTarget] = useState<number | null>(null);
  const [reorderAfter, setReorderAfter] = useState(false);
  // 같은 제품 행 위에 드롭하면 '묶기(merge)' — 이 행을 초록으로 강조한다(삽입선 대신).
  const [mergeHoverId, setMergeHoverId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
  // 설비 행에서 수정을 시작한 경우 그 설비 id(저장 시 추가된 구성을 이 설비에 바로 배정). 대기에서 수정하면 null.
  const [editMachineId, setEditMachineId] = useState<number | null>(null);
  // 설비 행(엔트리)에서 다구성 주문을 수정할 때, 그 행만 편집(별도 건)하기 위한 엔트리 정보.
  const [editEntryId, setEditEntryId] = useState<number | null>(null);
  const [editEntryParts, setEditEntryParts] = useState<string[]>([]);
  const [newOrder, setNewOrder] = useState({
    order_code: "", product_name: "", component: "", quantity_sheets: 0,
    deadline: "", special_process: "일반", priority: 5, notes: "", extra_notes: "", duration_hours: 0,
    productivity: 0, // 제책: 부/시간. 부수 ÷ 생산성 = 소요시간(시간)
    partHours: {} as Record<string, number>,
    partProcesses: {} as Record<string, string>,
    partQuantities: {} as Record<string, number>,
  });
  // 구성 칩을 🗑로 끌어다 놓는 중인 행(완료·삭제 강조)
  const [trashOverEntry, setTrashOverEntry] = useState<number | null>(null);
  const dragOverMachine = useRef<number | null>(null);
  const [machineStartTimes, setMachineStartTimes] = useState<Record<number, string>>({});
  const [machineMemos, setMachineMemos] = useState<Record<number, string>>({});
  // 설비 블록 하단 기타사항(제책) 자유 입력
  const [machineExtras, setMachineExtras] = useState<Record<number, string>>({});
  // 기타사항 요일칸 높이(설비별, 7칸 공통). 하단 핸들을 드래그하면 한 번에 전체 변경.
  const [extraHeights, setExtraHeights] = useState<Record<number, number>>({});
  // 인쇄 출력 종류: 'order'=기계별 작업순서표, 'full'=스케줄 전체 개요(기계계획+1차배정+대기)
  const [printView, setPrintView] = useState<"order" | "full">("order");
  const wantPrint = useRef(false);

  const fetchAll = useCallback(async () => {
    const qs = `?process_line=${encodeURIComponent(processLine)}`;
    // 식사시간(breaks)은 전 공정 공통이라 process_line 필터 없이 받는다.
    const [machRes, orderRes, schedRes, bucketRes, breakRes, dtRes] = await Promise.all([
      fetch(`/api/machines${qs}`), fetch(`/api/orders${qs}`), fetch(`/api/schedule${qs}`), fetch(`/api/buckets${qs}`), fetch(`/api/breaks`), fetch(`/api/downtimes`),
    ]);
    const machData = await machRes.json();
    const orderData = await orderRes.json();
    const schedData = await schedRes.json();
    const bucketData = await bucketRes.json();
    const breakData = await breakRes.json();
    const dtData = await dtRes.json().catch(() => []);
    setBreaks(Array.isArray(breakData) ? breakData : []);
    setDowntimes(Array.isArray(dtData) ? dtData : []);
    const activeMachines = machData.filter((m: Machine) => m.is_active);
    setMachines(activeMachines);
    // 배정 대기 풀: pending 주문 + 이미 배정됐어도(scheduled) '미배정으로 남은 구성'이 있는 다중구성 주문.
    // (예: MB10에 배정된 주문에 구성을 추가하면 그 새 구성이 대기에 떠야 한다)
    const orderHasRemaining = (o: Order): boolean => {
      const parts = parseParts(o.component);
      if (parts.length < 2) return false; // 구성 없는/단일 주문은 status로만 판단
      const totals = partTotals(o.component, o.part_durations, o.duration_minutes);
      const present = new Set<string>();
      const alloc: Record<string, number> = {};
      for (const s of (schedData as ScheduleEntry[])) {
        if (s.order_id !== o.id) continue;
        parseParts(s.component_part).forEach((p) => present.add(p));
        for (const [p, m] of Object.entries(parsePartDurations(s.part_durations))) alloc[p] = (alloc[p] || 0) + (Number(m) || 0);
      }
      return parts.some((p) => { const t = Number(totals[p]) || 0; return t > 0 ? (alloc[p] || 0) < t : !present.has(p); });
    };
    setOrders(orderData.filter((o: Order) => o.status === "pending" || orderHasRemaining(o)));
    setAllOrders(Array.isArray(orderData) ? orderData : []);
    setSchedule(schedData);
    setBuckets(Array.isArray(bucketData) ? bucketData : []);
    setMachineStartTimes((prev) => {
      const next = { ...prev };
      for (const m of activeMachines) {
        if (!(m.id in next)) {
          next[m.id] = m.schedule_start_time || "08:00";
        }
      }
      return next;
    });
    setMachineMemos((prev) => {
      const next = { ...prev };
      for (const m of activeMachines) {
        if (!(m.id in next)) next[m.id] = m.memo || "";
      }
      return next;
    });
    setMachineExtras((prev) => {
      const next = { ...prev };
      for (const m of activeMachines) {
        if (!(m.id in next)) next[m.id] = m.extra_notes || "";
      }
      return next;
    });
  }, [processLine]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // 드래그 중 화면 위/아래 가장자리에 커서가 가면 설비 목록을 자동 스크롤(맨 아래→맨 위 설비로도 옮길 수 있게).
  const listScrollRef = useRef<HTMLDivElement>(null);
  const dragPointerY = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    const onOver = (e: DragEvent) => { dragPointerY.current = e.clientY; };
    const onEnd = () => { dragPointerY.current = null; };
    const loop = () => {
      const el = listScrollRef.current;
      const y = dragPointerY.current;
      if (el && y != null) {
        const r = el.getBoundingClientRect();
        const EDGE = 90, MAX = 22;
        if (y - r.top < EDGE) el.scrollTop -= MAX * Math.max(0.15, 1 - (y - r.top) / EDGE);
        else if (r.bottom - y < EDGE) el.scrollTop += MAX * Math.max(0.15, 1 - (r.bottom - y) / EDGE);
      }
      raf = requestAnimationFrame(loop);
    };
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragend", onEnd);
    document.addEventListener("drop", onEnd);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragend", onEnd);
      document.removeEventListener("drop", onEnd);
    };
  }, []);

  // 스케줄 출력의 배정 내역은 제품명·비고·완료시간 3등분. 제품명/비고가 칸(1/3)을 넘으면
  // 실제 글자폭을 측정해 폰트를 유동 축소(각 칸 한 줄 유지).
  // 인쇄 영역은 화면에서 display:none이라 직접 측정이 안 되므로 숨김 span으로 폭을 잰다.
  // (print effect보다 먼저 선언해 인쇄 전에 폰트가 맞춰지도록 한다)
  useEffect(() => {
    if (printView !== "full" || isJechae) return;
    const root = document.querySelector(".print-area");
    if (!root) return;
    const lis = root.querySelectorAll<HTMLElement>(".pf-li");
    const rows = root.querySelectorAll<HTMLElement>(".pf-row"); // 배정 대기 항목(2열)
    if (!lis.length && !rows.length) return;
    const PXMM = 96 / 25.4;          // 1mm → px (96dpi)
    const BASE_PT = 7;               // 배정 내역 기본 폰트(축소)
    const LIST_W = 90 * PXMM;        // 인쇄 시 박스 내부(작업 목록) 가용 폭 ≈ 90mm 고정
    const GAP = 1.5 * PXMM;          // 칸 사이 간격
    const SAFETY = 1.5 * PXMM;       // 반올림 줄바꿈 방지 여백
    const usable = LIST_W - 2 * GAP;
    const JOB_W = usable * 5 / 9 - SAFETY;  // 제품명 칸(5/9, 넓게)
    const NOTE_W = usable * 2 / 9 - SAFETY; // 비고 칸(2/9)
    const WAIT_W = 44 * PXMM;               // 배정 대기 2열 한 칸 폭 ≈ 44mm
    const ref = lis[0]?.querySelector<HTMLElement>(".pf-job") ?? rows[0] ?? document.body;
    const cs = getComputedStyle(ref);
    const meas = document.createElement("span");
    meas.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;";
    meas.style.fontFamily = cs.fontFamily;
    meas.style.fontWeight = cs.fontWeight;
    meas.style.fontSize = `${(BASE_PT * 96) / 72}px`;
    document.body.appendChild(meas);
    const fit = (el: HTMLElement | null, colW: number) => {
      if (!el) return;
      meas.textContent = el.textContent || "";
      const w = meas.getBoundingClientRect().width;
      el.style.fontSize = w > colW && colW > 0
        ? `${Math.max(3, Math.round((BASE_PT * colW) / w * 10) / 10)}pt`
        : "";
    };
    lis.forEach((li) => {
      fit(li.querySelector<HTMLElement>(".pf-job"), JOB_W);
      fit(li.querySelector<HTMLElement>(".pf-note"), NOTE_W);
    });
    rows.forEach((el) => fit(el, WAIT_W));
    document.body.removeChild(meas);
  }, [schedule, machines, printView, isJechae]);

  // 작업순서 출력의 작업명(print-name-main)도 한 줄을 넘으면 폰트를 실측해 유동 축소.
  //  단, 비고(print-note)는 별도 줄이므로 측정/축소 대상에서 제외(작업명 길이만 본다).
  useEffect(() => {
    if (printView !== "order") return;
    const root = document.querySelector(".print-area");
    if (!root) return;
    const mains = root.querySelectorAll<HTMLElement>(".print-name-main");
    if (!mains.length) return;
    const PXMM = 96 / 25.4;
    const BASE_PT = 11;              // print-name 기본 폰트
    const AVAIL = (82 - 4 - 2) * PXMM; // 칸 82mm - 좌우 패딩 4mm - 안전 여백 2mm = 76mm
    const cs = getComputedStyle(mains[0]);
    const meas = document.createElement("span");
    meas.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;";
    meas.style.fontFamily = cs.fontFamily;
    meas.style.fontWeight = cs.fontWeight;
    meas.style.fontSize = `${(BASE_PT * 96) / 72}px`;
    document.body.appendChild(meas);
    mains.forEach((el) => {
      meas.textContent = el.textContent || "";
      const w = meas.getBoundingClientRect().width;
      el.style.fontSize = w > AVAIL && AVAIL > 0
        ? `${Math.max(6, Math.round((BASE_PT * AVAIL) / w * 10) / 10)}pt`
        : "";
    });
    document.body.removeChild(meas);
  }, [schedule, machines, printView]);

  // 인쇄 뷰가 바뀐 뒤(원하는 출력이 렌더된 후) 실제 인쇄 대화상자를 띄운다.
  useEffect(() => {
    if (wantPrint.current) { wantPrint.current = false; window.print(); }
  }, [printView]);
  const triggerPrint = (view: "order" | "full") => {
    if (view === printView) { window.print(); }
    else { wantPrint.current = true; setPrintView(view); }
  };


  const memoTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // 설비 메모(자유 수기) 저장. 스케줄에 영향 없으므로 재계산/전체조회 없이 PATCH만 한다.
  const handleMemoChange = (machineId: number, value: string) => {
    setMachineMemos((prev) => ({ ...prev, [machineId]: value }));
    const existing = memoTimers.current.get(machineId);
    if (existing) clearTimeout(existing);
    memoTimers.current.set(
      machineId,
      setTimeout(async () => {
        await fetch(`/api/machines/${machineId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memo: value }),
        });
        memoTimers.current.delete(machineId);
      }, 600)
    );
  };

  const extraTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // 설비 블록 하단 기타사항(자유 수기) 저장. 스케줄에 영향 없으므로 PATCH만 (디바운스).
  const handleMachineExtraChange = (machineId: number, value: string) => {
    setMachineExtras((prev) => ({ ...prev, [machineId]: value }));
    const existing = extraTimers.current.get(machineId);
    if (existing) clearTimeout(existing);
    extraTimers.current.set(
      machineId,
      setTimeout(async () => {
        await fetch(`/api/machines/${machineId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extra_notes: value }),
        });
        extraTimers.current.delete(machineId);
      }, 600)
    );
  };

  // 기타사항 칸 높이 조절: 하단 핸들 드래그 → 해당 설비 7칸 높이를 한꺼번에 변경.
  const startExtraResize = (machineId: number, e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = extraHeights[machineId] ?? 64;
    const onMove = (ev: PointerEvent) => {
      const h = Math.max(36, startH + (ev.clientY - startY));
      setExtraHeights((prev) => ({ ...prev, [machineId]: h }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // #번호 클릭 → 표시 색상 토글(없음 ↔ 노랑). DB 저장으로 여러 관리자 공유.
  const cycleMark = async (entry: ScheduleEntry) => {
    if (!isAdmin) return;
    const cur = entry.mark_color || "";
    const next = MARK_CYCLE[(MARK_CYCLE.indexOf(cur) + 1) % MARK_CYCLE.length];
    setSchedule((prev) => prev.map((e) => (e.id === entry.id ? { ...e, mark_color: next } : e)));
    await fetch("/api/schedule/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entry.id, color: next }),
    });
  };

  // 이동·수정한 항목을 핑크(rose)로 자동 표시 — 관리자가 옮긴 것 식별용.
  // 그 주문이 대상 설비에 만든/바뀐 엔트리를 핑크로 칠한다(이동은 새 엔트리가 생기므로 다시 조회해 찾는다).
  const markMoved = async (orderId: number | null, machineId: number) => {
    if (!isAdmin || orderId == null) return;
    try {
      const sch = await fetch(`/api/schedule?process_line=${encodeURIComponent(processLine)}`).then((r) => r.json());
      if (!Array.isArray(sch)) return;
      const ids = (sch as ScheduleEntry[]).filter((e) => e.order_id === orderId && e.machine_id === machineId).map((e) => e.id);
      if (!ids.length) return;
      setSchedule((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, mark_color: "rose" } : e)));
      await Promise.all(ids.map((id) => fetch("/api/schedule/mark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry_id: id, color: "rose" }) })));
    } catch { /* 무시 */ }
  };

  // 식사시간 추가/수정/삭제. 변경 시 서버가 전 설비 일정을 재계산하므로, 끝나면 fetchAll로 갱신한다.
  const addBreak = async () => {
    setLoading(true);
    await fetch("/api/breaks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "식사", start_min: 12 * 60, end_min: 13 * 60 }),
    });
    await fetchAll();
    setLoading(false);
  };

  const updateBreak = async (id: number, patch: Partial<Pick<Break, "name" | "start_min" | "end_min">>) => {
    setLoading(true);
    await fetch(`/api/breaks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await fetchAll();
    setLoading(false);
  };

  const deleteBreak = async (id: number) => {
    if (!window.confirm("이 식사시간을 삭제할까요? 예상완료시간이 다시 계산됩니다.")) return;
    setLoading(true);
    await fetch(`/api/breaks/${id}`, { method: "DELETE" });
    await fetchAll();
    setLoading(false);
  };

  // 비가동시간 추가/삭제. 변경 시 서버가 해당 설비를 재계산하므로, 끝나면 fetchAll로 갱신한다.
  const addDowntime = async (machineId: number) => {
    if (!dtForm.start || !dtForm.end) { alert("시작/종료 일시를 입력하세요."); return; }
    if (new Date(dtForm.end) <= new Date(dtForm.start)) { alert("종료가 시작보다 늦어야 합니다."); return; }
    setLoading(true);
    const r = await fetch("/api/downtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: machineId, start_time: dtForm.start, end_time: dtForm.end, reason: dtForm.reason }),
    });
    if (!r.ok) { alert((await r.json().catch(() => ({}))).error || "추가 실패"); setLoading(false); return; }
    setDtForm({ start: "", end: "", reason: "" });
    await fetchAll();
    setLoading(false);
  };
  const deleteDowntime = async (id: number) => {
    setLoading(true);
    await fetch(`/api/downtimes/${id}`, { method: "DELETE" });
    await fetchAll();
    setLoading(false);
  };

  const handleAssign = async (orderId: number, machineId: number, part: string = "", allocMinutes: number = 0, beforeEntryId: number | null = null, merge: boolean = false, mergeEntryId: number | null = null) => {
    setLoading(true);
    const startTime = machineStartTimes[machineId] || "08:00";
    await fetch("/api/schedule/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // merge=true면 같은 제품 행(merge_entry_id)에 합치고, 아니면 드롭 위치에 독립 행으로 둔다.
      body: JSON.stringify({ order_id: orderId, machine_id: machineId, start_time: startTime, component_part: part, alloc_minutes: allocMinutes, before_entry_id: beforeEntryId, merge, merge_entry_id: mergeEntryId }),
    });
    await fetchAll();
    await markMoved(orderId, machineId);
    setLoading(false);
  };

  // 주문의 남은 파트 전체를 한 설비에 배정 (각 파트의 남은 시간만큼).
  // onlyParts가 있으면 그 구성들만 배정한다(칸 카드를 기계로 끌 때 그 칸의 구성만).
  const handleAssignAll = async (orderId: number, machineId: number, beforeEntryId: number | null = null, onlyParts: string[] = []) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;
    setLoading(true);
    const startTime = machineStartTimes[machineId] || "08:00";
    const allParts = parseParts(order.component);
    const parts = onlyParts.length ? allParts.filter((p) => onlyParts.includes(p)) : allParts;
    const totals = partTotals(order.component, order.part_durations, order.duration_minutes);
    const present = new Set<string>();
    const alloc: Record<string, number> = {};
    for (const s of schedule) {
      if (s.order_id !== orderId) continue;
      parseParts(s.component_part).forEach((p) => present.add(p));
      for (const [p, m] of Object.entries(parsePartDurations(s.part_durations))) {
        alloc[p] = (alloc[p] || 0) + (Number(m) || 0);
      }
    }
    if (allParts.length === 0) {
      // 구성 없는 주문: 통째 배정
      await fetch("/api/schedule/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: orderId, machine_id: machineId, start_time: startTime, component_part: "", before_entry_id: beforeEntryId, merge: true }),
      });
    } else {
      for (const p of parts) {
        const t = Number(totals[p]) || 0;
        let allocMin = 0;
        if (t > 0) {
          const rem = t - (alloc[p] || 0);
          if (rem <= 0) continue;
          allocMin = rem;
        } else if (present.has(p)) {
          continue;
        }
        // merge:true → 카드 본문(전체) 배정은 같은 제품 구성을 한 행으로 묶는다
        await fetch("/api/schedule/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_id: orderId, machine_id: machineId, start_time: startTime, component_part: p, alloc_minutes: allocMin, before_entry_id: beforeEntryId, merge: true }),
        });
      }
    }
    await fetchAll();
    await markMoved(orderId, machineId);
    setLoading(false);
  };

  const handleReorderParts = async (entryId: number, parts: string[]) => {
    // 낙관적 갱신: 구성 순서만 바뀌고 시간 재계산은 없으므로 로컬에서 즉시 반영한다.
    // (서버 왕복·전체 재조회를 기다리지 않아 칩이 부드럽게 움직인다.)
    setSchedule((prev) => prev.map((e) => (e.id === entryId ? { ...e, component_part: parts.join(", ") } : e)));
    try {
      await fetch("/api/schedule/reorder-parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: entryId, parts }),
      });
    } catch {
      await fetchAll(); // 실패하면 서버 상태로 되돌린다
    }
  };

  const handleMovePart = async (entryId: number, part: string, targetMachineId: number, srcMachineId: number, moveMinutes: number = 0, beforeEntryId: number | null = null, merge: boolean = false, mergeEntryId: number | null = null) => {
    setLoading(true);
    const movedOid = schedule.find((s) => s.id === entryId)?.order_id ?? null;
    await fetch("/api/schedule/move-part", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: entryId,
        part,
        target_machine_id: targetMachineId,
        move_minutes: moveMinutes,
        source_start_time: machineStartTimes[srcMachineId] || "08:00",
        target_start_time: machineStartTimes[targetMachineId] || "08:00",
        before_entry_id: beforeEntryId,
        // merge=true면 같은 제품 행(merge_entry_id)에 묶고, 아니면 드롭 위치에 독립 행으로.
        merge,
        merge_entry_id: mergeEntryId,
      }),
    });
    await fetchAll();
    await markMoved(movedOid, targetMachineId);
    setLoading(false);
  };

  // 통째(구성 미분할) 배정 행을 다른 설비로 이동/분할. moveMinutes가 행 전체보다 작으면 분할 생산.
  // merge=true면 같은 주문의 기존 행(mergeEntryId)에 합친다(분할된 제품을 하나로).
  const handleMoveEntry = async (entryId: number, targetMachineId: number, srcMachineId: number, moveMinutes: number = 0, beforeEntryId: number | null = null, merge: boolean = false, mergeEntryId: number | null = null) => {
    setLoading(true);
    const movedOid = schedule.find((s) => s.id === entryId)?.order_id ?? null;
    await fetch("/api/schedule/move-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: entryId,
        target_machine_id: targetMachineId,
        move_minutes: moveMinutes,
        source_start_time: machineStartTimes[srcMachineId] || "08:00",
        target_start_time: machineStartTimes[targetMachineId] || "08:00",
        before_entry_id: beforeEntryId,
        merge,
        merge_entry_id: mergeEntryId,
      }),
    });
    await fetchAll();
    await markMoved(movedOid, targetMachineId);
    setLoading(false);
  };

  const handleUnassign = async (entryId: number) => {
    setLoading(true);
    await fetch("/api/schedule/unassign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entryId }),
    });
    await fetchAll();
    setLoading(false);
  };

  const handleUnassignPart = async (entryId: number, part: string) => {
    setLoading(true);
    await fetch("/api/schedule/unassign-part", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entryId, part }),
    });
    await fetchAll();
    setLoading(false);
  };

  // 완료된 구성(칩) 영구 삭제: 엔트리에서 제거 + 주문 사양에서도 제거(대기로 복귀하지 않음)
  const handleCompletePart = async (entryId: number, part: string) => {
    setLoading(true);
    await fetch("/api/schedule/complete-part", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entryId, part }),
    });
    await fetchAll();
    setLoading(false);
  };

  // 주문(물량) 영구 삭제: 설비 배정·1차 배정 내역도 FK CASCADE로 함께 삭제된다.
  const handleDeleteOrder = async (orderId: number, productName: string) => {
    if (!window.confirm(`'${productName}' 주문을 영구 삭제할까요?\n설비 배정·1차 배정 내역이 모두 함께 삭제되며 되돌릴 수 없습니다.`)) return;
    setLoading(true);
    await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
    await fetchAll();
    setLoading(false);
  };

  // 배정 대기 영역에 드롭 = 배정/1차배정 취소
  const onDropOnWaiting = async () => {
    if (dragSplit !== null) {
      await handleUnassignPart(dragSplit.entryId, dragSplit.part);
    } else if (dragEntryId !== null) {
      await handleUnassign(dragEntryId);
    } else if (dragOrderId !== null) {
      // 1차 배정 칸에서 끌어온 구성을 대기로: 끌어온 구성만(없으면 주문 전체) 1차 배정 해제
      await handleStage1(dragOrderId, null, dragParts);
    }
    setDragOrderId(null);
    setDragPart("");
    setDragParts([]);
    setDragEntryId(null);
    setDragSplit(null);
    setDragAll(false);
    setDropTarget(null);
  };

  // 1차 배정: 주문을 칸에 넣거나(bucketId) 해제(null). parts가 있으면 그 구성들만(구성별),
  // 비어 있으면 주문 전체(제품별, bucket_id)로 처리한다.
  const handleStage1 = async (orderId: number, bucketId: number | null, parts: string[] = []) => {
    setLoading(true);
    await fetch("/api/schedule/stage1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId, bucket_id: bucketId, parts: parts.length ? parts : undefined }),
    });
    await fetchAll();
    setLoading(false);
  };

  // 칸(버킷)에 드롭 = 1차 배정. 대기/다른 칸의 주문, 또는 기계에 배정된 작업을 끌어다 넣을 수 있다.
  // 끌어온 구성(parts)만 해당 칸에 넣는다. 구성 없는 주문이면 parts=[]로 주문 전체(bucket_id) 처리.
  const onDropOnBucket = async (bucketId: number) => {
    let orderId: number | null = null;
    let parts: string[] = [];
    if (dragSplit !== null) {
      const e = schedule.find((s) => s.id === dragSplit.entryId);
      if (e) { orderId = e.order_id; parts = [dragSplit.part]; await handleUnassignPart(dragSplit.entryId, dragSplit.part); }
    } else if (dragEntryId !== null) {
      const e = schedule.find((s) => s.id === dragEntryId);
      if (e) { orderId = e.order_id; parts = parseParts(e.component_part); await handleUnassign(dragEntryId); }
    } else if (dragOrderId !== null) {
      orderId = dragOrderId;
      parts = dragParts;
    }
    if (orderId !== null) await handleStage1(orderId, bucketId, parts);
    setDragOrderId(null);
    setDragPart("");
    setDragParts([]);
    setDragEntryId(null);
    setDragSplit(null);
    setDragAll(false);
    setDropBucket(null);
    setDropTarget(null);
  };

  const addBucket = async () => {
    const name = window.prompt("새 1차 배정 칸 이름 (예: 국, 4×6, MB6, HDP)");
    if (!name || !name.trim()) return;
    setLoading(true);
    await fetch("/api/buckets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), process_line: processLine }),
    });
    await fetchAll();
    setLoading(false);
  };

  const renameBucket = async (id: number, name: string) => {
    const trimmed = name.trim();
    const b = buckets.find((x) => x.id === id);
    if (!trimmed || (b && b.name === trimmed)) return;
    await fetch(`/api/buckets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    await fetchAll();
  };

  const deleteBucket = async (b: Bucket) => {
    if (!window.confirm(`'${b.name}' 칸을 삭제할까요?\n이 칸에 있던 주문은 '배정 대기'로 돌아갑니다.`)) return;
    setLoading(true);
    await fetch(`/api/buckets/${b.id}`, { method: "DELETE" });
    await fetchAll();
    setLoading(false);
  };

  const moveBucket = async (idx: number, dir: number) => {
    const arr = [...buckets];
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    setBuckets(arr);
    await fetch("/api/buckets/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: arr.map((x) => x.id) }),
    });
    await fetchAll();
  };

  const handleReorder = async (machineId: number, entryIds: number[]) => {
    // 낙관적 갱신: 순서를 로컬에서 즉시 반영해 부드럽게 움직이고, 예상완료시간은 서버 재계산 후 동기화한다.
    const movedOid = dragEntryId != null ? (schedule.find((s) => s.id === dragEntryId)?.order_id ?? null) : null;
    const seqMap = new Map(entryIds.map((id, i) => [id, i + 1] as const));
    setSchedule((prev) => prev.map((e) => (seqMap.has(e.id) ? { ...e, sequence: seqMap.get(e.id)! } : e)));
    await fetch("/api/schedule/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: machineId, entry_ids: entryIds }),
    });
    await fetchAll();
    await markMoved(movedOid, machineId);
  };

  const durationTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const handleDurationChange = (entryId: number, hours: number) => {
    // 입력값은 실제(인쇄 모드 적용 후) 소요시간. 서버에서 단면 기준 base로 환산해 저장한다.
    const minutes = Math.round(hours * 60);
    setSchedule((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, duration_minutes: minutes } : e))
    );
    const existing = durationTimers.current.get(entryId);
    if (existing) clearTimeout(existing);
    durationTimers.current.set(
      entryId,
      setTimeout(async () => {
        await fetch("/api/schedule/duration", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry_id: entryId, duration_minutes: minutes }),
        });
        await fetchAll();
        durationTimers.current.delete(entryId);
      }, 600)
    );
  };

  const handlePrintModeToggle = async (entry: ScheduleEntry) => {
    setLoading(true);
    const newMode = entry.print_mode === "single" ? "double" : "single";
    await fetch("/api/schedule/print-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entry.id, mode: newMode }),
    });
    await fetchAll();
    setLoading(false);
  };

  const resetForm = () => {
    setNewOrder({
      order_code: "", product_name: "", component: "", quantity_sheets: 0,
      deadline: "", special_process: "일반", priority: 5, notes: "", extra_notes: "", duration_hours: 0,
      productivity: 0,
      partHours: {},
      partProcesses: {},
      partQuantities: {},
    });
    setShowAddForm(false);
    setEditingOrderId(null);
    setEditMachineId(null);
    setEditEntryId(null);
    setEditEntryParts([]);
  };

  // 대기 주문 편집 시작: 폼을 해당 주문 값으로 채운다
  // asCopy=true면 같은 사양으로 '새 주문'을 만든다(값만 채우고 editingOrderId는 비움 → 저장 시 신규 생성).
  // 한 제품을 생산하다 중단·다른 제품 후 이어서 생산하는 계획에서, 다시 입력하지 않고 분량만 고쳐 배정할 수 있다.
  const startEditOrder = (order: Order, asCopy = false, fromMachineId: number | null = null, entry: ScheduleEntry | null = null) => {
    // 설비 행에서 수정 + 다구성 주문이면 '그 행(엔트리)의 구성만' 편집(별도 건). 그 외엔 주문 전체 편집.
    const scoped = !asCopy && entry != null && parseParts(order.component).length >= 2 && parseParts(entry.component_part).length >= 1;
    const parts = scoped ? parseParts(entry!.component_part) : parseParts(order.component);
    const pd = parsePartDurations(scoped ? entry!.part_durations : order.part_durations);
    const pp = parsePartProcesses(order.part_processes);
    const pq = parsePartDurations(order.part_quantities);
    const partHours: Record<string, number> = {};
    const partProcesses: Record<string, string> = {};
    const partQuantities: Record<string, number> = {};
    for (const p of parts) {
      partHours[p] = Math.round(((Number(pd[p]) || 0) / 60));
      partProcesses[p] = pp[p] || order.special_process || "일반";
      partQuantities[p] = Number(pq[p]) || order.quantity_sheets || 0;
    }
    setNewOrder({
      order_code: order.order_code || "",
      product_name: order.product_name,
      component: scoped ? entry!.component_part : (order.component || ""),
      quantity_sheets: order.quantity_sheets || 0,
      deadline: order.deadline || "",
      special_process: order.special_process ?? "일반",
      priority: order.priority || 5,
      notes: order.notes || "",
      extra_notes: order.extra_notes || "",
      duration_hours: parts.length >= 2 ? 0 : (scoped ? Math.round((Number(pd[parts[0]]) || 0) / 60) : Math.round((order.duration_minutes || 0) / 60)),
      // 생산성은 부수 ÷ 소요시간으로 역산(저장 없이 복원)
      productivity: (() => {
        const durH = (order.duration_minutes || 0) / 60;
        return order.quantity_sheets && durH > 0 ? Math.round(order.quantity_sheets / durH) : 0;
      })(),
      partHours,
      partProcesses,
      partQuantities,
    });
    setEditingOrderId(asCopy ? null : order.id);
    setEditMachineId(asCopy ? null : fromMachineId);
    setEditEntryId(scoped ? entry!.id : null);
    setEditEntryParts(scoped ? parts : []);
    setShowAddForm(true);
  };

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const parts = parseParts(newOrder.component);
    let partDurations: Record<string, number> = {};
    const partProcesses: Record<string, string> = {};
    let durationMinutes = 0;
    if (parts.length >= 2) {
      // 구성이 여러 개면 파트별 소요시간/구분을 저장, 전체 소요는 합계 (윤전은 구분 없음)
      for (const p of parts) {
        partDurations[p] = Math.round((newOrder.partHours[p] || 0) * 60);
        partProcesses[p] = usesQuantity ? "" : (newOrder.partProcesses[p] || newOrder.special_process || "일반");
      }
      durationMinutes = Object.values(partDurations).reduce((a, b) => a + b, 0);
    } else {
      durationMinutes = Math.round((newOrder.duration_hours || 0) * 60);
    }
    // 윤전은 구분 없음(빈값). 매엽=공정, 제책=배정대기 구분(무선/낙정/배접; 그 외엔 미지정='').
    const specialProcess = isRoll
      ? ""
      : isJechae
        ? ((JECHAE_CATS as readonly string[]).includes(newOrder.special_process) ? newOrder.special_process : "")
        : newOrder.special_process;
    if (editingOrderId !== null && editEntryId !== null) {
      // 스코프 수정: 같은 주문이 여러 설비에 쪼개져 있어도 '이 설비 행(엔트리)'의 구성만 편집(별도 건).
      // 주문에는 병합 저장(다른 설비/대기 구성은 그대로), 이 엔트리만 직접 갱신해 바로 반영.
      const existingStatus = allOrders.find((o) => o.id === editingOrderId)?.status || "pending";
      const origOrder = allOrders.find((o) => o.id === editingOrderId);
      const origParts = parseParts(origOrder?.component || "");
      const origPD = parsePartDurations(origOrder?.part_durations);
      const origPP = parsePartProcesses(origOrder?.part_processes);
      const minutesOf = (p: string) => (parts.length >= 2 ? (partDurations[p] || 0) : durationMinutes);
      const kept = origParts.filter((p) => !editEntryParts.includes(p)); // 다른 설비/대기에 있던 구성
      const mergedComp = [...kept, ...parts.filter((p) => !kept.includes(p))];
      const mergedPD: Record<string, number> = {};
      const mergedPP: Record<string, string> = {};
      for (const p of kept) { mergedPD[p] = Number(origPD[p]) || 0; mergedPP[p] = origPP[p] || ""; }
      for (const p of parts) { mergedPD[p] = minutesOf(p); mergedPP[p] = partProcesses[p] ?? ""; }
      await fetch(`/api/orders/${editingOrderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          component: mergedComp.join(", "),
          special_process: specialProcess,
          duration_minutes: Object.values(mergedPD).reduce((a, b) => a + b, 0),
          part_durations: mergedPD,
          part_processes: mergedPP,
          part_quantities: {},
          status: existingStatus,
        }),
      });
      await fetch("/api/schedule/set-entry-parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: editEntryId, parts: parts.map((p) => ({ name: p, minutes: minutesOf(p) })) }),
      });
    } else if (editingOrderId !== null) {
      // 배정 완료된 작업을 설비 화면에서 수정해도 상태가 대기로 바뀌지 않도록 기존 상태 유지
      const existingStatus = allOrders.find((o) => o.id === editingOrderId)?.status || "pending";
      await fetch(`/api/orders/${editingOrderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          special_process: specialProcess,
          duration_minutes: durationMinutes,
          part_durations: partDurations,
          part_processes: partProcesses,
          part_quantities: {},
          status: existingStatus,
        }),
      });
      // 설비 행에서 수정한 경우: 새로 추가된 구성(아직 어느 설비에도 배정 안 됨)을 그 설비에 바로 병합 배정.
      if (editMachineId !== null && parts.length >= 2) {
        const assigned = new Set<string>();
        for (const s of schedule) if (s.order_id === editingOrderId) parseParts(s.component_part).forEach((p) => assigned.add(p));
        const newParts = parts.filter((p) => !assigned.has(p));
        for (const p of newParts) {
          await fetch("/api/schedule/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order_id: editingOrderId, machine_id: editMachineId, start_time: machineStartTimes[editMachineId] || "08:00", component_part: p, merge: true }),
          });
        }
      }
    } else {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          special_process: specialProcess,
          duration_minutes: durationMinutes,
          part_durations: partDurations,
          part_processes: partProcesses,
          part_quantities: {},
          process_line: processLine,
        }),
      });
    }
    // 설비 행에서 수정한 경우, 그 주문의 해당 설비 엔트리를 핑크로 표시(어떤 걸 고쳤는지 식별).
    const markCtx = editingOrderId !== null && editMachineId !== null ? { oid: editingOrderId, mid: editMachineId } : null;
    resetForm();
    await fetchAll();
    if (markCtx) await markMoved(markCtx.oid, markCtx.mid);
  };

  const onDragStartOrder = (orderId: number, part: string = "") => {
    if (!isAdmin) return; // 보기 전용: 드래그 배정 불가
    setDragOrderId(orderId);
    setDragPart(part);
    setDragParts(part ? [part] : []); // 1차 배정 시 이 구성만 옮긴다
    setDragEntryId(null);
    setDragSplit(null);
    setDragAll(false);
  };

  // 제품 카드 본문을 드래그 = (기계로) 남은 파트 전체를 한 설비로 / (칸으로) 이 카드에 보이는 구성 전체를 한 칸으로
  const onDragStartAll = (orderId: number, parts: string[] = []) => {
    if (!isAdmin) return; // 보기 전용: 드래그 배정 불가
    setDragOrderId(orderId);
    setDragPart("");
    setDragParts(parts); // 1차 배정 시 이 구성들을 한 칸으로
    setDragAll(true);
    setDragEntryId(null);
    setDragSplit(null);
  };

  const onDragOverMachine = (e: React.DragEvent, machineId: number) => {
    e.preventDefault();
    dragOverMachine.current = machineId;
    if (dropTarget !== machineId) setDropTarget(machineId);
  };

  // 주문의 특정 파트가 아직 배정되지 않은 남은 시간(분)
  const partRemaining = (order: Order, part: string) => {
    const totals = partTotals(order.component, order.part_durations, order.duration_minutes);
    const total = Number(totals[part]) || 0;
    let allocated = 0;
    for (const s of schedule) {
      if (s.order_id !== order.id) continue;
      allocated += Number(parsePartDurations(s.part_durations)[part]) || 0;
    }
    return { total, allocated, remaining: total - allocated };
  };

  // 모든 드래그 상태 초기화
  const clearDragState = () => {
    setDragOrderId(null);
    setDragPart("");
    setDragParts([]);
    setDragEntryId(null);
    setDragSplit(null);
    setDragAll(false);
    setDropTarget(null);
    setMergeHoverId(null);
  };

  // 현재 드래그 중인 항목이 속한 주문 id (없으면 null)
  const draggedOrderId = (): number | null => {
    if (dragSplit !== null) return schedule.find((s) => s.id === dragSplit.entryId)?.order_id ?? null;
    if (dragOrderId !== null) return dragOrderId;
    if (dragEntryId !== null) return schedule.find((s) => s.id === dragEntryId)?.order_id ?? null;
    return null;
  };

  // 이 행에 드롭하면 '같은 제품 묶기(merge)'가 되는가.
  // 구성 칩 이동(dragSplit)·대기/칸의 파트나 카드(dragOrderId) 드래그에만 적용. 전체 행 이동(dragEntryId)은 위치 이동.
  const wouldMerge = (entry: ScheduleEntry): boolean => {
    const oid = draggedOrderId();
    if (oid == null || oid !== entry.order_id) return false;
    if (dragSplit !== null) return dragSplit.entryId !== entry.id;
    if (dragOrderId !== null) return dragAll || dragPart !== "";
    // 통째 행(분할 생산된 행)을 같은 제품의 다른 행에 드롭하면 하나로 합친다
    if (dragEntryId !== null) return dragEntryId !== entry.id;
    return false;
  };

  // dropEntry: 마우스를 올린 그 행(빈 영역 드롭이면 null). 같은 제품이면 그 행에 묶고, 아니면 드롭 위치에 분리한다.
  const onDropOnMachine = async (machineId: number, beforeEntryId: number | null = null, dropEntry: ScheduleEntry | null = null) => {
    const dOid = draggedOrderId();
    const mergeTarget =
      dropEntry && dOid != null && dropEntry.order_id === dOid && dropEntry.machine_id === machineId ? dropEntry : null;

    if (dragSplit !== null) {
      const srcEntry = schedule.find((s) => s.id === dragSplit.entryId);
      if (srcEntry) {
        if (mergeTarget && mergeTarget.id !== srcEntry.id) {
          // 같은 제품의 다른 행에 이 구성을 묶는다(전체 이동, 시간 입력 없음).
          await handleMovePart(dragSplit.entryId, dragSplit.part, machineId, srcEntry.machine_id, 0, beforeEntryId, true, mergeTarget.id);
        } else if (srcEntry.machine_id !== machineId) {
          // 다른 설비로 분리 이동: 옮길 시간을 입력받아 일부만 이동 가능 (기본=현재 배정량 전체)
          const srcAlloc = Number(parsePartDurations(srcEntry.part_durations)[dragSplit.part]) || 0;
          if (srcAlloc > 0) {
            const defH = Math.round(srcAlloc / 60);
            const input = window.prompt(`'${dragSplit.part}' 이 설비로 옮길 시간(시간)\n현재 ${defH}시간`, String(defH));
            if (input === null) { clearDragState(); return; }
            const hours = Number(input);
            if (!Number.isFinite(hours) || hours <= 0) { clearDragState(); return; }
            const mins = Math.min(Math.round(hours * 60), srcAlloc);
            await handleMovePart(dragSplit.entryId, dragSplit.part, machineId, srcEntry.machine_id, mins, beforeEntryId, false);
          } else {
            await handleMovePart(dragSplit.entryId, dragSplit.part, machineId, srcEntry.machine_id, 0, beforeEntryId, false);
          }
        } else {
          // 같은 설비, 다른 제품 위치로 = 이 구성만 분리해 드롭 위치에 독립 행으로
          const srcParts = parseParts(srcEntry.component_part);
          if (srcParts.length <= 1) {
            // 단일 구성 행이면 행 자체를 재배치(소요시간·인쇄모드 등 메타 보존)
            const ordered = getEntriesForMachine(machineId).map((x) => x.id).filter((id) => id !== srcEntry.id);
            let pos = beforeEntryId == null ? ordered.length : ordered.indexOf(beforeEntryId);
            if (pos < 0) pos = ordered.length;
            ordered.splice(pos, 0, srcEntry.id);
            await handleReorder(machineId, ordered);
          } else {
            await handleMovePart(dragSplit.entryId, dragSplit.part, machineId, machineId, 0, beforeEntryId, false);
          }
        }
      }
    } else if (dragOrderId !== null) {
      if (dragAll) {
        // 이 카드의 구성 전체(대기/칸에 보이는 것)를 이 설비로 배정 (같은 제품은 묶임)
        await handleAssignAll(dragOrderId, machineId, beforeEntryId, dragParts);
      } else if (dragPart) {
        const order = orders.find((o) => o.id === dragOrderId);
        const { total, remaining } = order ? partRemaining(order, dragPart) : { total: 0, remaining: 0 };
        if (mergeTarget) {
          // 같은 제품 행에 이 파트를 묶어 배정 (남은 시간 전체, 시간 입력 없음)
          await handleAssign(dragOrderId, machineId, dragPart, remaining > 0 ? remaining : 0, beforeEntryId, true, mergeTarget.id);
        } else if (total > 0) {
          // 독립 행 배정: 이 설비에 배정할 시간을 입력받아 분할 배정 (남은 시간 추적)
          const defHours = Math.round((remaining > 0 ? remaining : total) / 60);
          const input = window.prompt(`'${dragPart}' 이 설비에 배정할 시간(시간)\n남은 시간: ${Math.round(remaining / 60)}시간`, String(defHours));
          if (input === null) { clearDragState(); return; }
          const hours = Number(input);
          if (!Number.isFinite(hours) || hours <= 0) { clearDragState(); return; }
          const mins = Math.min(Math.round(hours * 60), remaining > 0 ? remaining : Math.round(hours * 60));
          await handleAssign(dragOrderId, machineId, dragPart, mins, beforeEntryId, false);
        } else {
          await handleAssign(dragOrderId, machineId, dragPart, 0, beforeEntryId, false);
        }
      } else {
        await handleAssign(dragOrderId, machineId, "", 0, beforeEntryId, false);
      }
    } else if (dragEntryId !== null) {
      const entry = schedule.find((s) => s.id === dragEntryId);
      if (entry && entry.machine_id !== machineId) {
        // 설비→설비 이동: 옮길 시간을 입력받아 일부만 분할 이동 가능 (기본=전체)
        const totalMin = entry.duration_minutes || 0;
        if (totalMin > 0) {
          const defH = Math.round((totalMin / 60) * 10) / 10;
          const input = window.prompt(`이 작업을 이 설비로 옮길 시간(시간)\n전체 ${defH}시간 (그대로 두면 전체 이동, 적게 쓰면 분할 생산)`, String(defH));
          if (input === null) { clearDragState(); return; }
          const hours = Number(input);
          if (!Number.isFinite(hours) || hours <= 0) { clearDragState(); return; }
          const mins = Math.round(hours * 60);
          await handleMoveEntry(entry.id, machineId, entry.machine_id, mins >= totalMin ? 0 : mins, beforeEntryId);
        } else {
          await handleMoveEntry(entry.id, machineId, entry.machine_id, 0, beforeEntryId);
        }
      }
    }
    clearDragState();
  };

  const getEntriesForMachine = (machineId: number) =>
    schedule.filter((s) => s.machine_id === machineId).sort((a, b) => a.sequence - b.sequence);


  const PROCESSES = ["일반", "항바니쉬", "UV", "IR코팅", "양면", "패키지"];

  // 주문의 '남은 구성'(아직 기계에 다 배정되지 않은 구성) 목록
  const remainingPartsOf = (order: Order): string[] => {
    const parts = parseParts(order.component);
    if (parts.length === 0) return [];
    const totals = partTotals(order.component, order.part_durations, order.duration_minutes);
    const present = new Set<string>();
    const alloc: Record<string, number> = {};
    for (const s of schedule) {
      if (s.order_id !== order.id) continue;
      parseParts(s.component_part).forEach((p) => present.add(p));
      for (const [p, m] of Object.entries(parsePartDurations(s.part_durations))) {
        alloc[p] = (alloc[p] || 0) + (Number(m) || 0);
      }
    }
    return parts.filter((p) => {
      const t = Number(totals[p]) || 0;
      return t > 0 ? (alloc[p] || 0) < t : !present.has(p);
    });
  };

  // 구성별 1차 배정 칸. part_buckets에 있으면 그 값, 없으면 주문 전체 bucket_id로 폴백(하위호환).
  const partBucketOf = (order: Order, part: string): number | null => {
    const map = parsePartBuckets(order.part_buckets);
    return part in map ? map[part] : order.bucket_id;
  };

  // 특정 위치(대기=undefined / 칸=bucketId)에 표시할 '남은 구성' 목록
  const partsAtLocation = (order: Order, bucketId?: number): string[] =>
    remainingPartsOf(order).filter((p) =>
      bucketId === undefined ? partBucketOf(order, p) == null : partBucketOf(order, p) === bucketId,
    );

  // 주문이 해당 위치(대기/칸)에 카드로 표시되어야 하는지
  const showsAt = (order: Order, bucketId?: number): boolean => {
    if (parseParts(order.component).length === 0) {
      return bucketId === undefined ? order.bucket_id == null : order.bucket_id === bucketId;
    }
    return partsAtLocation(order, bucketId).length > 0;
  };

  // 1차 배정 안 된(대기) 구성이 남아 있는 주문
  const waitingOrders = orders.filter((o) => showsAt(o, undefined));

  // 분 → "N.Nh" (소요시간 합계 표기)
  const fmtH = (min: number) => `${Math.round(min / 6) / 10}h`;

  // 스케줄을 엑셀(.xlsx)로 내려받기. 설비별 작업을 순서대로 한 행씩. 클릭 시에만 라이브러리를 동적 로드.
  // 제책용 '날짜 × 설비' 매트릭스 데이터. 각 작업을 시작~완료 날짜마다 해당 설비 칸에 넣는다.
  // (여러 날 걸치는 작업은 그 날짜들마다 반복 표기 — 업로드 엑셀과 동일한 일자별 계획)
  const ymd2 = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const offDaysOf = (m: Machine): Set<number> => {
    try { const a = JSON.parse(m.off_days || "[]"); return new Set(Array.isArray(a) ? a.map(Number) : []); } catch { return new Set(); }
  };
  const buildJechaeMatrix = () => {
    const cell: Record<string, Record<number, { label: string; note: string; dur: string }[]>> = {};
    for (const m of machines) {
      const off = offDaysOf(m);
      for (const e of getEntriesForMachine(m.id)) {
        if (!e.start_time || !e.end_time) continue;
        const start = new Date(e.start_time.slice(0, 10) + "T00:00");
        // 완료가 정확히 00:00이면 전날 24:00에 끝난 것 → 마지막 작업일은 전날
        const end = new Date(e.end_time.slice(0, 10) + "T00:00");
        if (/00:00$/.test(e.end_time.replace("T", " "))) end.setDate(end.getDate() - 1);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) continue;
        const comp = e.component_part || e.component || "";
        const qty = e.quantity_sheets ? ` = ${e.quantity_sheets.toLocaleString()}부` : "";
        const label = `${e.product_name}${comp ? `(${comp})` : ""}${qty}`;
        const note = (e.order_notes || "").trim();
        const h = e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : 0;
        const dur = h ? `${h}H` : "";
        const job = { label, note, dur };
        for (let cur = new Date(start), g = 0; cur <= end && g < 400; cur.setDate(cur.getDate() + 1), g++) {
          if (off.has(cur.getDay())) continue; // 휴무 요일은 제외
          const dk = ymd2(cur);
          (cell[dk] ??= {});
          (cell[dk][m.id] ??= []).push(job);
        }
      }
    }
    return { cell, dates: Object.keys(cell).sort() };
  };

  const downloadExcel = async () => {
    const mod = await import("xlsx");
    const XLSX = "utils" in mod ? mod : (mod as unknown as { default: typeof mod }).default;
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const wb = XLSX.utils.book_new();
    if (isJechae) {
      // 출력물(요일×설비 매트릭스)과 동일: 이번 주(월~토)만, 각 칸에 그 설비의 작업들 + 기타사항(※).
      // 한 칸에 여러 작업이면 작업당 한 행으로 펼치고 날짜(요일)는 첫 행에만 표기.
      const { cell } = buildJechaeMatrix();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const week = Array.from({ length: 6 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
      const fmtMD = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
      const exByMachine: Record<number, Record<string, string>> = {};
      for (const m of machines) exByMachine[m.id] = parseExtraNotes(machineExtras[m.id] ?? m.extra_notes ?? "");
      // 한 설비·하루의 칸 내용 라인들: 작업들(제품 · 비고 · 시간) 다음에 기타사항(※).
      const linesFor = (m: Machine, d: Date): string[] => {
        const out = (cell[ymd2(d)]?.[m.id] || []).map((j) => [j.label, j.note, j.dur].filter(Boolean).join(" · "));
        const note = (exByMachine[m.id]?.[WD_KEY[d.getDay()]] || "").trim();
        if (note) out.push(`※ ${note}`);
        return out;
      };
      const head = `${processLine} 생산 스케줄 — ${fmtMD(week[0])}(${DAY_NAMES[week[0].getDay()]}) ~ ${fmtMD(week[5])}(${DAY_NAMES[week[5].getDay()]})    출력 ${printStamp}`;
      const aoa: (string | number)[][] = [[head], ["요일", ...machines.map((m) => m.name)]];
      for (const d of week) {
        const perM = machines.map((m) => linesFor(m, d));
        const maxL = Math.max(1, ...perM.map((a) => a.length));
        for (let k = 0; k < maxL; k++) {
          aoa.push([k === 0 ? `${DAY_NAMES[d.getDay()]} ${fmtMD(d)}` : "", ...perM.map((a) => a[k] || "")]);
        }
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wch = (m: Machine) => (m.name.includes("낙정") || m.name.includes("배접") ? 22 : 30);
      ws["!cols"] = [{ wch: 11 }, ...machines.map((m) => ({ wch: wch(m) }))];
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: machines.length } }]; // 제목 행 가로 병합
      XLSX.utils.book_append_sheet(wb, ws, processLine);
      XLSX.writeFile(wb, `스케줄_${processLine}_${ymd}.xlsx`);
      return;
    }
    const rows: Record<string, string | number>[] = [];
    for (const m of machines) {
      getEntriesForMachine(m.id).forEach((e, i) => {
        rows.push({
          설비: m.name,
          순서: i + 1,
          제품명: e.product_name,
          구성: e.component_part || e.component || "",
          공정: e.special_process || "",
          [qtyLabel]: e.quantity_sheets || "",
          "소요(시간)": e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : "",
          // 화면 표기와 동일하게: 예상완료를 "요일 HH:MM"(자정은 전일 24:00)으로
          예상완료: e.end_time ? formatEndTime(e.end_time) : "",
          납기: e.deadline || "",
          비고: e.order_notes || "",
        });
      });
    }
    if (rows.length === 0) rows.push({ 설비: "(배정된 작업 없음)" });
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, processLine);
    XLSX.writeFile(wb, `스케줄_${processLine}_${ymd}.xlsx`);
  };

  // 제책 스케줄을 PPT(.pptx)로 — 출력물(요일×설비 주간 매트릭스)을 슬라이드 2장(월화수/목금토)으로 재현.
  // 엑셀과 달리 셀 안 줄바꿈·배경색·정렬이 자유로워 출력물과 동일하게 표현된다.
  const downloadPpt = async () => {
    const PptxGenJS = (await import("pptxgenjs")).default;
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "A4L", width: 11.69, height: 8.27 }); // A4 가로
    pptx.layout = "A4L";
    const FONT = "Malgun Gothic";
    const d0 = new Date();
    const ymd = `${d0.getFullYear()}${String(d0.getMonth() + 1).padStart(2, "0")}${String(d0.getDate()).padStart(2, "0")}`;

    const { cell } = buildJechaeMatrix();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const week = Array.from({ length: 6 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
    const chunks = [week.slice(0, 3), week.slice(3, 6)]; // 월화수 / 목금토 (한 슬라이드씩)
    const fmtMD = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    const exByMachine: Record<number, Record<string, string>> = {};
    for (const m of machines) exByMachine[m.id] = parseExtraNotes(machineExtras[m.id] ?? m.extra_notes ?? "");

    // 열 너비: 낙정·배접은 20%만 축소(=80%), 그만큼 무선 열로 — 출력물과 동일.
    const isMuseon = (m: Machine) => m.name.includes("무선");
    const isNakBae = (m: Machine) => m.name.includes("낙정") || m.name.includes("배접");
    const numMuseon = machines.filter(isMuseon).length;
    const numNakBae = machines.filter(isNakBae).length;
    const museonExtra = numMuseon > 0 ? (0.2 * numNakBae) / numMuseon : 0;
    const weightOf = (m: Machine) => (isNakBae(m) ? 0.8 : isMuseon(m) ? 1 + museonExtra : 1);
    const totalW = machines.reduce((s, m) => s + weightOf(m), 0) || 1;
    const TABLE_W = 11.2, DATE_W = 0.85;
    const colW = [DATE_W, ...machines.map((m) => ((TABLE_W - DATE_W) * weightOf(m)) / totalW)];

    // 한 설비·하루 칸: 작업들(제품 굵게 + 비고·시간 회색) 다음에 기타사항(※).
    type Run = { text: string; options?: Record<string, unknown> };
    const cellFor = (m: Machine, d: Date) => {
      const jobs = cell[ymd2(d)]?.[m.id] || [];
      const note = (exByMachine[m.id]?.[WD_KEY[d.getDay()]] || "").trim();
      const runs: Run[] = [];
      for (const j of jobs) {
        const sub = [j.note, j.dur].filter(Boolean).join(" · ");
        runs.push({ text: j.label, options: { bold: true, breakLine: !sub } });
        if (sub) runs.push({ text: sub, options: { fontSize: 8, color: "555555", breakLine: true } });
      }
      if (note) runs.push({ text: `※ ${note}`, options: { fontSize: 8, italic: true, color: "1F4E79", breakLine: true } });
      if (runs.length === 0) runs.push({ text: "" });
      return { text: runs, options: { valign: "top", align: "left", fontSize: 10 } };
    };

    for (const days of chunks) {
      const slide = pptx.addSlide();
      slide.addText(
        `${processLine} 생산 스케줄 — ${fmtMD(days[0])}(${DAY_NAMES[days[0].getDay()]}) ~ ${fmtMD(days[days.length - 1])}(${DAY_NAMES[days[days.length - 1].getDay()]})`,
        { x: 0.25, y: 0.18, w: 8.5, h: 0.45, fontSize: 16, bold: true, color: "1F4E79", fontFace: FONT },
      );
      slide.addText(`출력 ${printStamp}`, { x: 8.4, y: 0.28, w: 3, h: 0.3, align: "right", fontSize: 9, color: "666666", fontFace: FONT });

      const headFill = "2E75B6";
      const header = [
        { text: "요일", options: { fill: headFill, color: "FFFFFF", bold: true, align: "center", valign: "middle" } },
        ...machines.map((m) => ({ text: m.name, options: { fill: headFill, color: "FFFFFF", bold: true, align: "center", valign: "middle" } })),
      ];
      const body = days.map((d) => [
        { text: [{ text: DAY_NAMES[d.getDay()], options: { bold: true, breakLine: true } }, { text: fmtMD(d), options: { fontSize: 9, color: "333333" } }], options: { align: "center", valign: "middle", fill: "F2F2F2", bold: true } },
        ...machines.map((m) => cellFor(m, d)),
      ]);
      const rowH = [0.32, ...days.map(() => (8.27 - 0.75 - 0.32 - 0.2) / days.length)];
      slide.addTable([header, ...body] as never, {
        x: 0.25, y: 0.72, w: TABLE_W, colW, rowH,
        border: { type: "solid", pt: 0.5, color: "888888" },
        fontFace: FONT, fontSize: 10, valign: "top", autoPage: false,
      });
    }
    await pptx.writeFile({ fileName: `스케줄_${processLine}_${ymd}.pptx` });
  };

  // 특정 위치(대기=undefined / 칸=bucketId)에 표시되는 주문들의 '남은 구성' 소요시간 합계(분)
  const locationMinutes = (orderList: Order[], bucketId?: number) =>
    orderList.reduce((sum, o) => {
      const parts = parseParts(o.component);
      if (parts.length === 0) return sum + (o.duration_minutes || 0);
      const totals = partTotals(o.component, o.part_durations, o.duration_minutes);
      const alloc: Record<string, number> = {};
      for (const s of schedule) {
        if (s.order_id !== o.id) continue;
        for (const [p, m] of Object.entries(parsePartDurations(s.part_durations))) {
          alloc[p] = (alloc[p] || 0) + (Number(m) || 0);
        }
      }
      return sum + partsAtLocation(o, bucketId).reduce((s2, p) => {
        const t = Number(totals[p]) || 0;
        return s2 + (t > 0 ? t - (alloc[p] || 0) : 0);
      }, 0);
    }, 0);

  // 주문 카드 (배정 대기 / 1차 배정 칸 공용). bucketId=undefined면 대기, 숫자면 그 칸.
  // 해당 위치에 표시할 남은 구성이 없으면 렌더하지 않음.
  const renderOrderCard = (order: Order, bucketId?: number) => {
    const parts = parseParts(order.component);
    const hasParts = parts.length >= 1;
    const totals = partTotals(order.component, order.part_durations, order.duration_minutes);
    const alloc: Record<string, number> = {};
    for (const s of schedule) {
      if (s.order_id !== order.id) continue;
      for (const [p, m] of Object.entries(parsePartDurations(s.part_durations))) {
        alloc[p] = (alloc[p] || 0) + (Number(m) || 0);
      }
    }
    // 이 위치(대기/칸)에 표시할 남은 구성만 추린다
    const remainingParts = partsAtLocation(order, bucketId);
    if (hasParts && remainingParts.length === 0) return null;
    if (!hasParts && !showsAt(order, bucketId)) return null;
    return (
      <div
        key={order.id}
        draggable={isAdmin}
        onDragStart={() => (hasParts ? onDragStartAll(order.id, remainingParts) : onDragStartOrder(order.id))}
        title={hasParts ? "이 카드의 구성 전체를 설비/칸으로 드래그 (칸=한 칸에 모아 1차 배정)" : undefined}
        className={`p-2.5 border transition hover:shadow-sm cursor-grab active:cursor-grabbing ${
          dragOrderId === order.id && !dragPart ? "opacity-40" : ""
        } border-gray-200 bg-white`}
      >
        <div>
          <div className="flex items-center justify-between">
            <p className="font-medium text-xs leading-tight min-w-0 flex-1 break-all">{order.product_name}</p>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {isAdmin && (<>
              <button
                onClick={(e) => { e.stopPropagation(); startEditOrder(order); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="text-gray-400 hover:text-blue-600 text-base leading-none px-1 py-0.5"
                title="주문 수정"
              >
                ✎
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); startEditOrder(order, true); }}
                onMouseDown={(e) => e.stopPropagation()}
                className="text-gray-400 hover:text-green-600 text-base leading-none px-1 py-0.5"
                title="같은 사양으로 새 주문 만들기 (복사)"
              >
                ⧉
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteOrder(order.id, order.product_name); }}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={loading}
                className="text-gray-400 hover:text-red-600 text-base leading-none px-1 py-0.5"
                title="주문 삭제"
              >
                🗑
              </button>
              </>)}
            </div>
          </div>
          {hasParts ? (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {remainingParts.map((p) => {
                const t = Number(totals[p]) || 0;
                const rem = t > 0 ? t - (alloc[p] || 0) : 0;
                const proc = parsePartProcesses(order.part_processes)[p] || order.special_process;
                const label = t > 0 ? `${p} (${Math.round(rem / 60)}h)` : p;
                return (
                  <span
                    key={p}
                    draggable={isAdmin}
                    onDragStart={(e) => { e.stopPropagation(); onDragStartOrder(order.id, p); }}
                    onDragEnd={() => { setDragOrderId(null); setDragPart(""); setDragParts([]); }}
                    className={`px-2 py-0.5 border text-[11px] font-medium cursor-grab active:cursor-grabbing hover:opacity-80 ${
                      PROCESS_COLORS[proc] || "bg-gray-100 text-gray-600 border-gray-200"
                    } ${dragOrderId === order.id && dragPart === p ? "opacity-40" : ""}`}
                    title={proc ? `${p} · ${proc} · 이 파트를 설비로 드래그하여 배정 (남은 시간 내에서 분할 가능)` : `${p} · 이 파트를 설비로 드래그하여 배정 (남은 시간 내에서 분할 가능)`}
                  >
                    {label}{proc ? <span className="opacity-70"> · {proc}</span> : null}
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-0.5 mt-1.5">
              {processesForParts(parts, order.part_processes, order.special_process).filter(Boolean).map((proc) => (
                <span key={proc} className={`px-1.5 py-0 text-[10px] font-medium border ${
                  PROCESS_COLORS[proc] || "bg-gray-100 text-gray-600 border-gray-200"
                }`}>
                  {proc}
                </span>
              ))}
            </div>
          )}
          {usesQuantity && order.quantity_sheets ? (
            <p className="text-xs font-medium text-gray-600 mt-1.5">{qtyLabel} : {order.quantity_sheets.toLocaleString()}부</p>
          ) : null}
          {order.notes && (
            <p className="text-xs text-gray-500 mt-1.5 break-all" title={order.notes}>비고 : {order.notes}</p>
          )}
        </div>
      </div>
    );
  };

  const now = new Date();
  const dateStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
  const p2x = (n: number) => String(n).padStart(2, "0");
  const printStamp = `${now.getFullYear()}-${p2x(now.getMonth() + 1)}-${p2x(now.getDate())} ${p2x(now.getHours())}:${p2x(now.getMinutes())}`;

  // 설비명 칸 너비 = 현재 탭에서 가장 긴 설비명의 실제 픽셀 폭(canvas 측정).
  // 설비명은 좌측 정렬, 칸 오른쪽에 좌측 패딩(px-4=16px)과 동일한 여백을 둔 뒤 메모란이 시작된다.
  const machineNameWidth = useMemo(() => {
    if (typeof document === "undefined" || machines.length === 0) return undefined;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return undefined;
    ctx.font = `700 16px ${getComputedStyle(document.body).fontFamily}`;
    const max = machines.reduce((mx, m) => Math.max(mx, ctx.measureText(m.name).width), 0);
    return `${Math.ceil(max)}px`;
  }, [machines]);

  // 인쇄용 작업명: "제품명(구성)소요시간" — 스케줄 출력물 기계 박스에서 사용
  const jobLabel = (e: ScheduleEntry): string => {
    const comp = e.component_part || e.component || "";
    const base = comp ? `${e.product_name}(${comp})` : e.product_name;
    const hours = e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : "";
    return hours !== "" ? `${base}${hours}` : base;
  };

  // 작업순서 출력물 첫 줄: "작업명 (공백) 소요시간" (비고는 다음 줄에 별도 렌더)
  const orderSheetLabel = (e: ScheduleEntry): string => {
    const comp = e.component_part || e.component || "";
    const name = comp ? `${e.product_name}(${comp})` : e.product_name;
    const hours = e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : "";
    return hours !== "" ? `${name} ${hours}` : name;
  };

  // 엑셀 '작업순서' 양식: 기계별 블록(제목 + 번호·작업명 목록)을 2열 그리드로. 인쇄 시에만 보인다.
  // 블록 1개 = 제목 18mm + 10행 × 11.2mm = 130mm 고정. 배정이 많아도 블록 크기(=출력 크기)만큼만
  // 보이도록 행수를 고정하고, 넘치는 건수는 제목에 "외 N건"으로만 표기한다.
  const PRINT_ROWS = 10;    // 블록당 고정 행수(인쇄 크기에 맞춤)
  const PRINT_PER_PAGE = 4; // 한 페이지 2열 × 2행
  const renderPrint = () => {
    const pages: Machine[][] = [];
    for (let i = 0; i < machines.length; i += PRINT_PER_PAGE) {
      pages.push(machines.slice(i, i + PRINT_PER_PAGE));
    }
    return pages.map((group, pi) => (
      // 페이지 단위로 감싸 상하·좌우 중앙 정렬 (용지 센터 출력 + 재단 편의)
      <div className="print-page" key={pi}>
        <div className="print-grid">
          {group.map((m) => {
            const entries = getEntriesForMachine(m.id);
            const overflowCount = Math.max(0, entries.length - PRINT_ROWS);
            const rowCount = PRINT_ROWS; // 항상 고정 — 초과 배정은 출력하지 않는다
            return (
              <table className="print-block" key={m.id}>
                <colgroup>
                  <col className="print-col-num" />
                  <col className="print-col-name" />
                </colgroup>
                <tbody>
                  <tr>
                    <th className="print-title" colSpan={2}>
                      {m.name} 작업순서
                      {overflowCount > 0 ? <span className="print-title-more"> · 외 {overflowCount}건</span> : null}
                    </th>
                  </tr>
                  {Array.from({ length: rowCount }).map((_, i) => {
                    const e = entries[i];
                    return (
                      <tr key={i}>
                        <td className="print-num">{e ? i + 1 : ""}</td>
                        <td className="print-name">
                          {e ? (
                            <>
                              <span className="print-name-main">{orderSheetLabel(e)}</span>
                              {e.order_notes && e.order_notes.trim() ? (
                                <span className="print-note">{e.order_notes.trim()}</span>
                              ) : null}
                            </>
                          ) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })}
        </div>
      </div>
    ));
  };

  // 제책 스케줄 인쇄: '요일(월~일) × 설비' 매트릭스. 이번 주 한 주만(고정 높이 7행).
  // 일요일 이후 작업은 표시하지 않는다(다음 주에 출력하면 그 주에 나옴).
  const renderJechaeMatrix = () => {
    const { cell } = buildJechaeMatrix();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const week = Array.from({ length: 6 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
    const chunks = [week.slice(0, 3), week.slice(3, 6)]; // 월화수 / 목금토 (한 페이지씩)
    const fmtMD = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
    // 열 너비: 낙정·배접은 20%만 축소(=원래의 80%), 그만큼 무선 열에 더해 확대.
    const isMuseon = (m: Machine) => m.name.includes("무선");
    const isNakBae = (m: Machine) => m.name.includes("낙정") || m.name.includes("배접");
    const numMuseon = machines.filter(isMuseon).length;
    const numNakBae = machines.filter(isNakBae).length;
    const museonExtra = numMuseon > 0 ? (0.2 * numNakBae) / numMuseon : 0;
    const weightOf = (m: Machine) => (isNakBae(m) ? 0.8 : isMuseon(m) ? 1 + museonExtra : 1);
    const totalW = machines.reduce((s, m) => s + weightOf(m), 0) || 1;
    const DATE_PCT = 5;
    const colPct = (m: Machine) => `${((100 - DATE_PCT) * weightOf(m)) / totalW}%`;
    const LAND_W = 281; // 가로 A4 가용 폭(mm, 여백 8mm 제외)
    const colMm = (m: Machine) => (LAND_W * (100 - DATE_PCT) / 100 * weightOf(m)) / totalW;
    // 한 페이지(가로 A4, 가용 ~194mm)에 3행이 꽉 차도록 높이를 크게.
    const PAGE_H = 190;
    const rowH = Math.max(20, Math.min(75, (PAGE_H - 16) / 3 - 2));
    const fitLines = Math.max(3, Math.floor(rowH / 3.6));
    const fsFor = (jobs: { label: string; note: string; dur: string }[], mm: number): string | undefined => {
      const cpl = Math.max(6, Math.floor(mm / 1.7));
      const lines = jobs.reduce((s, j) => s + Math.max(1, Math.ceil(j.label.length / cpl)) + (j.note || j.dur ? 1 : 0) + 0.6, 0);
      if (lines <= fitLines) return undefined;
      return `${Math.max(4, Math.round(7 * Math.sqrt(fitLines / lines) * 10) / 10)}pt`;
    };
    const cellH = `${rowH}mm`;
    // 설비별 기타사항(요일 키별)을 미리 파싱
    const exByMachine: Record<number, Record<string, string>> = {};
    for (const m of machines) exByMachine[m.id] = parseExtraNotes(machineExtras[m.id] ?? m.extra_notes ?? "");
    return (
      <>
        {chunks.map((days, ci) => (
          <div key={ci} className="pf-page pf-land" style={{ breakAfter: ci < chunks.length - 1 ? "page" : undefined }}>
            <div className="jm-week">
              <div className="pf-head jm-head">
                <span>{processLine} 생산 스케줄 — {fmtMD(days[0])}({DAY_NAMES[days[0].getDay()]}) ~ {fmtMD(days[days.length - 1])}({DAY_NAMES[days[days.length - 1].getDay()]})</span>
                <span className="jm-head-time">출력 {printStamp}</span>
              </div>
              <table className="jm">
                <thead>
                  <tr>
                    <th className="jm-dh" style={{ width: `${DATE_PCT}%` }}>요일</th>
                    {machines.map((m) => <th key={m.id} style={{ width: colPct(m) }}>{m.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {days.map((d, di) => {
                    const dk = ymd2(d);
                    return (
                      <tr key={di}>
                        <td className="jm-date">
                          <div className="jm-daycell jm-datecell" style={{ height: cellH }}>
                            <div className="jm-jobs">{DAY_NAMES[d.getDay()]}<br /><span className="jm-wd">{fmtMD(d)}</span></div>
                            <div className="jm-note" />
                          </div>
                        </td>
                        {machines.map((m) => {
                          const jobs = cell[dk]?.[m.id] || [];
                          return (
                            <td key={m.id} className="jm-cell">
                              <div className="jm-daycell" style={{ height: cellH }}>
                                <div className="jm-jobs" style={{ fontSize: fsFor(jobs, colMm(m)) }}>
                                  {jobs.map((j, i) => (
                                    <div key={i} className="jm-job">
                                      <div className="jm-job-name">{j.label}</div>
                                      {(j.note || j.dur) && <div className="jm-job-sub">{[j.note, j.dur].filter(Boolean).join(" · ")}</div>}
                                    </div>
                                  ))}
                                </div>
                                <div className="jm-note">{exByMachine[m.id]?.[WD_KEY[d.getDay()]] || ""}</div>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </>
    );
  };

  // 스케줄 전체 개요 인쇄: 상단 기계별 작업계획 + 하단 1차 배정·배정 대기. A4 한 장에 꽉 차게.
  const renderFullPrint = () => {
    const ov = (o: Order) => {
      const q = isRoll && o.quantity_sheets ? ` ${o.quantity_sheets.toLocaleString()}부` : "";
      return `${o.product_name}${o.component ? `(${o.component})` : ""}${q}`;
    };
    // 기계 박스(46mm 고정)에 들어가는 만큼만 표시 — 배정이 많아도 출력 크기를 넘지 않게 캡.
    // (작업명이 길어 한 줄을 넘으면 폰트를 실측해 유동 축소 — 위 useEffect가 담당)
    const PF_ROWS = 10;
    // 설비가 많아 그리드가 길어지면 하단 1차 배정(고정 80mm)이 A4 밖으로 잘린다.
    // 설비 수에 맞춰 박스 높이를 줄여 '설비 그리드 + 하단 80mm'가 항상 한 장에 들어가게 한다.
    // (설비 8대 이하면 기존 46mm 그대로, 9대 이상부터 축소)
    const numMachineRows = Math.max(1, Math.ceil(machines.length / 2));
    const machineRowH = Math.min(46, Math.max(28, (190 - (numMachineRows - 1) * 2.5) / numMachineRows));
    return (
      <div className="pf-page">
        <div className="pf-head pf-head-rel">{processLine} 생산 스케줄 — {dateStr}<span className="pf-head-time">출력 {printStamp}</span></div>
        <div className="pf-machines" style={{ gridAutoRows: `${machineRowH}mm` }}>
          {machines.map((m) => {
            const entries = getEntriesForMachine(m.id);
            const total = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
            const shown = entries.slice(0, PF_ROWS);
            const overflowCount = entries.length - shown.length;
            const memo = (machineMemos[m.id] ?? m.memo ?? "").trim();
            return (
              <div className="pf-mbox" key={m.id}>
                <div className="pf-mname">
                  <span className="pf-mname-l">{m.name}{overflowCount > 0 ? <span className="pf-more"> 외 {overflowCount}건</span> : null}{memo ? <span className="pf-memo-inline"> {memo}</span> : null}</span>
                  <span className="pf-mtime">{fmtH(total)}</span>
                </div>
                {entries.length === 0 ? (
                  <div className="pf-empty">-</div>
                ) : (
                  <ol className="pf-list">
                    {shown.map((e) => {
                      const lbl = jobLabel(e);
                      return (
                      <li key={e.id}>
                        <div className="pf-li">
                          <span className="pf-job">{lbl}</span>
                          <span className="pf-note">{(e.order_notes || "").trim()}</span>
                          <span className="pf-eta">{formatEndTime(e.end_time)}</span>
                        </div>
                      </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
        {!isJechae && (
        <div className="pf-bottom">
          <div className="pf-sect">
            <div className="pf-secttl">1차 배정 <span className="pf-secsum">{fmtH(buckets.reduce((s, b) => s + locationMinutes(orders.filter((o) => showsAt(o, b.id)), b.id), 0))}</span></div>
            <div className="pf-bk-grid">
              {Array.from({ length: 4 }).map((_, i) => {
                const b = buckets[i];
                const bo = b ? orders.filter((o) => showsAt(o, b.id)) : [];
                return (
                  <div key={i} className="pf-bk">
                    {b && (
                      <>
                        <div className="pf-bk-ttl">{b.name}<span className="pf-bk-sum">{fmtH(locationMinutes(bo, b.id))}</span></div>
                        <div className="pf-bk-items">
                          {bo.length ? bo.map((o) => <div key={o.id} className="pf-bk-item">{ov(o)}</div>) : <span className="pf-dim">-</span>}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="pf-sect">
            <div className="pf-secttl">배정 대기 <span className="pf-secsum">{fmtH(locationMinutes(waitingOrders, undefined))}</span></div>
            <div className="pf-secbody">
              {waitingOrders.map((o) => <div key={o.id} className="pf-row">{ov(o)}</div>)}
            </div>
          </div>
        </div>
        )}
      </div>
    );
  };

  return (
    <>
    <div className="print-root print-area">
      {printView === "full" ? (isJechae ? renderJechaeMatrix() : renderFullPrint()) : renderPrint()}
    </div>
    <div className="overflow-auto h-[calc(100vh-80px)]">
    {/* 고정 폭(반응형 축소 없음). 화면이 작으면 비율 축소 대신 가로/세로 스크롤로 본다. */}
    <div className="flex gap-4 h-full min-w-[1776px]">
      {/* 좌측: 설비별 배정 현황 */}
      <div ref={listScrollRef} className="flex-1 overflow-y-auto space-y-3 pr-2">
        <div className="flex items-center justify-between mb-2 sticky top-0 bg-gray-50 py-2 z-10">
          <div className="shrink-0">
            <h2 className="text-xl font-bold text-gray-900 whitespace-nowrap">기계별 작업 계획</h2>
            <p className="text-xs text-gray-500">{dateStr}</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {!isJechae && (
              <button
                onClick={() => triggerPrint("order")}
                className="text-xs border border-gray-300 bg-white px-2 py-1 hover:bg-gray-100 text-gray-700 whitespace-nowrap"
                title="기계별 작업순서를 엑셀 양식으로 인쇄합니다"
              >
                🖨 작업순서
              </button>
            )}
            <button
              onClick={() => triggerPrint("full")}
              className="text-xs border border-gray-300 bg-white px-2 py-1 hover:bg-gray-100 text-gray-700 whitespace-nowrap"
              title="기계별 작업계획을 A4 한 장에 인쇄합니다"
            >
              🖨 스케줄
            </button>
            <button
              onClick={isJechae ? downloadPpt : downloadExcel}
              className="text-xs border border-gray-300 bg-white px-2 py-1 hover:bg-gray-100 text-gray-700 whitespace-nowrap"
              title={isJechae ? "주간 스케줄을 출력물과 동일한 PPT(.pptx)로 내려받습니다" : "기계별 작업 계획을 엑셀(.xlsx) 파일로 내려받습니다"}
            >
              {isJechae ? "📑 PPT" : "📊 엑셀"}
            </button>
            {isAdmin && (
              <button
                onClick={() => setShowBreaks(true)}
                className="text-xs border border-gray-300 bg-white px-2 py-1 hover:bg-gray-100 text-gray-700 whitespace-nowrap"
                title="식사·휴게 시간을 추가/수정하면 예상완료시간이 자동으로 다시 계산됩니다"
              >
                🍽 식사시간 {breaks.length > 0 && <span className="text-gray-400">({breaks.length})</span>}
              </button>
            )}
          </div>
        </div>

        {machines.map((machine) => {
          const entries = getEntriesForMachine(machine.id);
          const isTarget = dropTarget === machine.id;

          return (
            <div
              key={machine.id}
              className={`bg-white border shadow-sm transition-all ${
                isTarget ? "ring-2 ring-blue-500 border-blue-300 bg-blue-50/30" : ""
              }`}
              onDragOver={(e) => onDragOverMachine(e, machine.id)}
              onDragLeave={() => { if (dragOverMachine.current === machine.id) setDropTarget(null); }}
              onDrop={() => onDropOnMachine(machine.id)}
            >
              <div className="bg-gray-800 text-white px-4 py-2 flex items-center">
                <span className="font-bold shrink-0 whitespace-nowrap mr-4" style={{ width: machineNameWidth }}>{machine.name}</span>
                <input
                  type="text"
                  className="flex-1 min-w-0 bg-gray-700 text-white text-xs px-2 py-0.5 border border-gray-500 focus:border-blue-400 outline-none disabled:opacity-60"
                  placeholder={isAdmin ? "메모" : ""}
                  value={machineMemos[machine.id] ?? ""}
                  onChange={(e) => handleMemoChange(machine.id, e.target.value)}
                  disabled={!isAdmin}
                />
                <div className="flex items-center gap-3 shrink-0 ml-8">
                  <span className="text-xs text-gray-400 whitespace-nowrap">시작 08:30 고정</span>
                  <button
                    onClick={() => { setDtModalMachine(machine.id); setDtForm({ start: "", end: "", reason: "" }); }}
                    className="text-xs px-2 py-0.5 border border-gray-500 bg-gray-700 text-gray-200 hover:bg-gray-600 whitespace-nowrap shrink-0"
                    title="설비 비가동시간(설비고장·교육훈련 등) 관리"
                  >
                    🛠 비가동{downtimes.filter((d) => d.machine_id === machine.id).length > 0 && <span className="text-gray-400"> ({downtimes.filter((d) => d.machine_id === machine.id).length})</span>}
                  </button>
                  <span className="text-sm text-gray-300 w-16 text-right shrink-0">{fmtH(entries.reduce((s, e) => s + (e.duration_minutes || 0), 0))}</span>
                </div>
              </div>

              {entries.length === 0 ? (
                <div className="px-4 py-6 text-center text-gray-400 text-sm">
                  우측에서 작업을 드래그하여 배정하세요
                </div>
              ) : (
                <div className="px-3 pb-2">
                <table className="w-full table-fixed">
                  <thead>
                    <tr className={`text-gray-500 border-b h-7 ${isJechae ? "text-[13px]" : "text-[10px]"}`}>
                      <th className="px-1.5 py-0 text-left w-6">#</th>
                      <th className="px-1.5 py-0 text-center">작업명</th>
                      <th className={`px-1.5 py-0 text-center ${isJechae ? "" : "w-44"}`}>비고</th>
                      <th className="px-1.5 py-0 text-center w-28">소요(시간)</th>
                      <th className={`px-1.5 py-0 whitespace-nowrap ${isJechae ? "text-center w-40" : "text-left w-32"}`}>예상완료</th>
                      <th className="px-1.5 py-0 text-center w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const isReorderHover = reorderTarget === entry.id;
                      const isMergeHover = mergeHoverId === entry.id;
                      return (
                        <tr
                          key={entry.id}
                          draggable={isAdmin}
                          onDragStart={() => {
                            setDragEntryId(entry.id);
                            setDragOrderId(null);
                            setDragPart("");
                            setDragSplit(null);
                          }}
                          onDragEnd={() => { setDragEntryId(null); setReorderTarget(null); setMergeHoverId(null); }}
                          style={isMergeHover ? undefined : { background: MARK_BG[entry.mark_color || ""] || undefined }}
                          className={`border-t cursor-grab active:cursor-grabbing h-7 hover:bg-gray-50 ${dragEntryId === entry.id ? "opacity-40" : ""} ${
                            isReorderHover ? (reorderAfter ? "border-b-2 border-b-blue-500" : "border-t-2 border-t-blue-500") : ""
                          } ${isMergeHover ? "ring-2 ring-inset ring-green-500 bg-green-50" : ""}`}
                          onDragOver={(e) => {
                            // 드래그 중인 자기 자신 / 같은 행 파트 재정렬은 무시 (칩 핸들러가 처리)
                            if (dragEntryId === entry.id) return;
                            if (dragSplit !== null && dragSplit.entryId === entry.id) return;
                            // 기존 재정렬 + 새 배정/이동 모두 이 행을 드롭 대상으로 허용
                            if (dragEntryId !== null || dragOrderId !== null || dragSplit !== null) {
                              e.preventDefault();
                              e.stopPropagation();
                              if (wouldMerge(entry)) {
                                // 같은 제품: 이 행에 묶기(merge) — 삽입선 대신 행 강조
                                if (mergeHoverId !== entry.id) setMergeHoverId(entry.id);
                                if (reorderTarget !== null) setReorderTarget(null);
                                if (dropTarget !== null) setDropTarget(null);
                                return;
                              }
                              // 커서가 행의 아래쪽 절반이면 이 행 '뒤(아래)'에 삽입
                              const r = e.currentTarget.getBoundingClientRect();
                              const after = e.clientY - r.top > r.height / 2;
                              if (reorderTarget !== entry.id) setReorderTarget(entry.id);
                              if (reorderAfter !== after) setReorderAfter(after);
                              if (mergeHoverId !== null) setMergeHoverId(null);
                              if (dropTarget !== null) setDropTarget(null);
                            }
                          }}
                          onDragLeave={() => {
                            if (reorderTarget === entry.id) setReorderTarget(null);
                            if (mergeHoverId === entry.id) setMergeHoverId(null);
                          }}
                          onDrop={(e) => {
                            if (dragEntryId === entry.id) return;
                            if (dragSplit !== null && dragSplit.entryId === entry.id) return;
                            if (dragEntryId === null && dragOrderId === null && dragSplit === null) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const r = e.currentTarget.getBoundingClientRect();
                            const after = e.clientY - r.top > r.height / 2;
                            setReorderTarget(null);
                            setMergeHoverId(null);
                            const fromEntry = dragEntryId !== null ? schedule.find((s) => s.id === dragEntryId) : null;
                            if (fromEntry && fromEntry.order_id === entry.order_id && fromEntry.id !== entry.id) {
                              // 같은 제품(분할된 행)을 이 행에 합치기 (같은 설비/다른 설비 모두)
                              handleMoveEntry(fromEntry.id, machine.id, fromEntry.machine_id, 0, null, true, entry.id);
                              setDragEntryId(null);
                              setDragOrderId(null);
                            } else if (fromEntry && fromEntry.machine_id === machine.id) {
                              // 같은 설비 내 순서 변경 (위/아래 절반에 따라 앞/뒤 삽입)
                              const currentEntries = [...entries];
                              const fromIdx = currentEntries.findIndex((x) => x.id === dragEntryId);
                              const [moved] = fromIdx >= 0 ? currentEntries.splice(fromIdx, 1) : [fromEntry];
                              let toIdx = currentEntries.findIndex((x) => x.id === entry.id);
                              if (toIdx < 0) toIdx = currentEntries.length;
                              else if (after) toIdx += 1;
                              currentEntries.splice(toIdx, 0, moved);
                              handleReorder(machine.id, currentEntries.map((x) => x.id));
                              setDragEntryId(null);
                              setDragOrderId(null);
                            } else {
                              // 새 배정 또는 다른 설비에서 이동 → 위/아래 절반에 따라 앞/뒤 위치에 삽입.
                              // 아래쪽이면 다음 행 앞에 삽입(= 이 행 뒤), 마지막 행이면 맨 아래에 추가(null).
                              const idxInEntries = entries.findIndex((x) => x.id === entry.id);
                              const nextEntry = entries[idxInEntries + 1];
                              const beforeId = after ? (nextEntry ? nextEntry.id : null) : entry.id;
                              onDropOnMachine(machine.id, beforeId, entry);
                            }
                          }}
                        >
                          <td
                            className={`px-1.5 py-0 text-[10px] select-none ${entry.mark_color ? "text-gray-700 font-bold" : "text-gray-400"} ${isAdmin ? "cursor-pointer hover:bg-black/10" : ""}`}
                            title={isAdmin ? "클릭: 표시 색상 변경 (수정 표시 — 모든 관리자 공유)" : ""}
                            draggable={false}
                            onClick={(e) => { e.stopPropagation(); cycleMark(entry); }}
                          >
                            {idx + 1}
                          </td>
                          <td className="px-1.5 py-0">
                            <div className="flex items-center gap-1 overflow-x-auto jobscroll">
                            <span className={`font-medium shrink-0 ${isJechae ? "text-[13px] text-black" : "text-[11px]"}`}>{entry.product_name}</span>
                            {(() => {
                              const eparts = parseParts(entry.component_part);
                              if (eparts.length === 0) {
                                // 구성이 단일(통째 배정)이거나 구성 미입력: 구분(있으면)·구성(있으면)을 칩으로 표시
                                return (
                                  <span className="inline-flex items-center gap-0.5 shrink-0">
                                    {entry.special_process ? (
                                      <span className={`px-1.5 py-0 text-[10px] font-medium border whitespace-nowrap ${PROCESS_COLORS[entry.special_process] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
                                        {entry.special_process}
                                      </span>
                                    ) : null}
                                    {entry.component ? (
                                      <span
                                        draggable={isAdmin}
                                        onDragStart={(e) => {
                                          e.stopPropagation();
                                          e.dataTransfer.effectAllowed = "move";
                                          setDragEntryId(entry.id);
                                          setDragOrderId(null);
                                          setDragPart("");
                                          setDragSplit(null);
                                        }}
                                        onDragEnd={() => setDragEntryId(null)}
                                        className={`px-1.5 py-0 border border-gray-300 bg-gray-100 text-gray-700 ${isJechae ? "text-[13px]" : "text-[10px]"} cursor-grab active:cursor-grabbing hover:bg-blue-100 hover:border-blue-300`}
                                        title="다른 설비로 드래그하여 이동"
                                      >
                                        {entry.component}
                                      </span>
                                    ) : null}
                                  </span>
                                );
                              }
                              const isReorderZone = dragSplit !== null && dragSplit.entryId === entry.id;
                              // 커서 X 위치에서 (끌고 있는 파트를 제외한) 가장 가까운 칩과 앞/뒤를 계산
                              const nearestTarget = (container: HTMLElement, clientX: number): { part: string; after: boolean } | null => {
                                if (!dragSplit) return null;
                                const els = Array.from(container.querySelectorAll("[data-part]")) as HTMLElement[];
                                let best: { part: string; after: boolean } | null = null;
                                let bestDist = Infinity;
                                for (const el of els) {
                                  const part = el.getAttribute("data-part");
                                  if (!part || part === dragSplit.part) continue;
                                  const r = el.getBoundingClientRect();
                                  const center = r.left + r.width / 2;
                                  const dist = Math.abs(clientX - center);
                                  if (dist < bestDist) {
                                    bestDist = dist;
                                    best = { part, after: clientX > center };
                                  }
                                }
                                return best;
                              };
                              const applyReorder = (t: { part: string; after: boolean } | null) => {
                                if (!dragSplit || !t) return;
                                const order = eparts.filter((x) => x !== dragSplit.part);
                                const idx = order.indexOf(t.part);
                                if (idx < 0) return;
                                order.splice(t.after ? idx + 1 : idx, 0, dragSplit.part);
                                handleReorderParts(entry.id, order);
                              };
                              // 구분(공정)이 같은 파트가 연속이면 구분 칩을 한 번만 표기한다: [구분][파트][파트]...
                              const partProc = (p: string) => parsePartProcesses(entry.part_processes)[p] || entry.special_process;
                              const procGroups: { proc: string; parts: string[] }[] = [];
                              for (const p of eparts) {
                                const proc = partProc(p);
                                const last = procGroups[procGroups.length - 1];
                                if (last && last.proc === proc) last.parts.push(p);
                                else procGroups.push({ proc, parts: [p] });
                              }
                              return (
                                <span
                                  className="inline-flex flex-nowrap items-center gap-1 align-middle"
                                  onDragOver={(e) => {
                                    if (isReorderZone) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const t = nearestTarget(e.currentTarget, e.clientX);
                                      // 값이 실제로 바뀔 때만 상태 갱신 (불필요한 리렌더 방지)
                                      setPartReorderTarget((prev) =>
                                        prev?.part === t?.part && prev?.after === t?.after ? prev : t
                                      );
                                    }
                                  }}
                                  onDragLeave={(e) => {
                                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setPartReorderTarget(null);
                                  }}
                                  onDrop={(e) => {
                                    if (isReorderZone) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      applyReorder(nearestTarget(e.currentTarget, e.clientX));
                                      setDragSplit(null);
                                      setPartReorderTarget(null);
                                    }
                                  }}
                                >
                                  {procGroups.map((g, gi) => (
                                    <span key={`${g.proc}-${gi}`} className="inline-flex items-center gap-0.5 shrink-0">
                                      {g.proc ? (
                                        <span className={`px-1.5 py-0 text-[10px] font-medium border whitespace-nowrap ${PROCESS_COLORS[g.proc] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
                                          {g.proc}
                                        </span>
                                      ) : null}
                                      {g.parts.map((p) => {
                                        const isTarget = isReorderZone && dragSplit!.part !== p && partReorderTarget?.part === p;
                                        return (
                                          <span
                                            key={p}
                                            data-part={p}
                                            draggable={isAdmin}
                                            onDragStart={(e) => {
                                              e.stopPropagation();
                                              e.dataTransfer.effectAllowed = "move";
                                              e.dataTransfer.setData("text/plain", p);
                                              setDragSplit({ entryId: entry.id, part: p });
                                              setDragEntryId(null);
                                              setDragOrderId(null);
                                              setDragPart("");
                                            }}
                                            onDragEnd={() => { setDragSplit(null); setPartReorderTarget(null); }}
                                            className={`px-1.5 py-0 border ${isJechae ? "text-[13px]" : "text-[10px]"} cursor-grab active:cursor-grabbing ${
                                              isTarget
                                                ? `bg-blue-50 text-blue-700 border-blue-500 ${partReorderTarget?.after ? "border-r-4" : "border-l-4"}`
                                                : "border-gray-300 bg-gray-100 text-gray-700 hover:bg-blue-100 hover:border-blue-300"
                                            }`}
                                            title="다른 설비로 드래그하면 분리, 같은 행에서 칩의 왼쪽/오른쪽으로 드롭하면 앞/뒤로 이동"
                                          >
                                            {p}
                                          </span>
                                        );
                                      })}
                                    </span>
                                  ))}
                                </span>
                              );
                            })()}
                            {usesQuantity && entry.quantity_sheets ? (
                              <span className={`font-medium text-gray-600 shrink-0 whitespace-nowrap ${isJechae ? "text-[13px]" : "text-[11px]"}`}>{entry.quantity_sheets.toLocaleString()}부</span>
                            ) : null}
                            </div>
                          </td>
                          <td className={`px-1.5 py-0 text-center truncate ${isJechae ? "text-[13px] text-black" : "text-[10px] text-gray-500"}`} title={entry.order_notes}>
                            {entry.order_notes}
                          </td>
                          <td className="px-1.5 py-0 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <input
                                type="number"
                                min="0"
                                step="0.5"
                                className="w-14 h-6 border border-gray-300 px-1 py-0 text-[11px] text-center font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                                value={entry.duration_minutes ? Math.round(entry.duration_minutes / 60 * 10) / 10 : ""}
                                placeholder="시간"
                                title={isRoll || isJechae ? "소요시간 (입력값 그대로 적용). 0.5시간(30분) 단위" : "실제 소요시간 (양면 설비는 절반 적용). 0.5시간(30분) 단위"}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => handleDurationChange(entry.id, Number(e.target.value) || 0)}
                                disabled={!isAdmin}
                              />
                              {/* 윤전은 양면 개념이 없어 양면/단면 칩·토글을 표시하지 않는다 (입력 소요시간 그대로). */}
                              {isRoll || isJechae ? null : isDoubleSided(machine.name) && isAdmin ? (
                                <button
                                  onClick={() => handlePrintModeToggle(entry)}
                                  disabled={loading}
                                  title="양면/단면 전환 (양면은 소요시간 절반)"
                                  className={`px-1 py-0 text-[9px] border ${
                                    entry.print_mode === "single"
                                      ? "bg-amber-100 text-amber-700 border-amber-300"
                                      : "bg-green-100 text-green-700 border-green-300"
                                  }`}
                                >
                                  {entry.print_mode === "single" ? "단면" : "양면"}
                                </button>
                              ) : (
                                <span className="text-[9px] text-gray-400">{entry.print_mode === "single" ? "단면" : "양면"}</span>
                              )}
                            </div>
                          </td>
                          <td className={`px-1.5 py-0 font-mono whitespace-nowrap text-gray-700 ${isJechae ? "text-[13px] text-center" : "text-[11px] text-left"}`}>
                            {formatEndTime(entry.end_time)}
                          </td>
                          <td className="px-1.5 py-0 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {isAdmin ? (<>
                              <button
                                onClick={() => { const o = allOrders.find((x) => x.id === entry.order_id); if (o) startEditOrder(o, false, entry.machine_id, entry); }}
                                disabled={loading}
                                className="text-gray-400 hover:text-blue-600 text-sm leading-none px-0.5"
                                title="작업 사양 수정 (제품명·구성·비고·납기 등) — 추가한 구성은 이 설비에 바로 배정됩니다"
                              >
                                ✎
                              </button>
                              <button
                                onClick={() => { const o = allOrders.find((x) => x.id === entry.order_id); if (o) startEditOrder(o, true); }}
                                disabled={loading}
                                className="text-gray-400 hover:text-green-600 text-sm leading-none px-0.5"
                                title="이 작업과 같은 사양으로 새 주문 만들기 (이어서 생산용 — 분량만 고쳐 배정)"
                              >
                                ⧉
                              </button>
                              <button
                                onClick={() => handleDeleteOrder(entry.order_id, entry.product_name)}
                                onDragOver={(e) => {
                                  // 구성 칩을 끌어다 놓으면 그 구성만 완료·삭제
                                  if (dragSplit !== null) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (trashOverEntry !== entry.id) setTrashOverEntry(entry.id);
                                  }
                                }}
                                onDragLeave={() => { if (trashOverEntry === entry.id) setTrashOverEntry(null); }}
                                onDrop={(e) => {
                                  if (dragSplit !== null) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleCompletePart(dragSplit.entryId, dragSplit.part);
                                    setTrashOverEntry(null);
                                    clearDragState();
                                  }
                                }}
                                disabled={loading}
                                className={`text-sm leading-none px-0.5 transition-transform ${trashOverEntry === entry.id ? "text-red-600 scale-150" : "text-gray-400 hover:text-red-600"}`}
                                title="클릭: 주문 전체 삭제 / 구성 칩을 끌어다 놓으면 그 구성만 완료·삭제"
                              >
                                🗑
                              </button>
                              </>) : <span className="text-gray-300">–</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
              {isJechae && (() => {
                const ex = parseExtraNotes(machineExtras[machine.id] ?? "");
                const setField = (key: string, val: string) =>
                  handleMachineExtraChange(machine.id, JSON.stringify({ ...ex, [key]: val }));
                const rowH = extraHeights[machine.id] ?? 64;
                return (
                  <div className="border-t border-black">
                    {/* 헤더는 흰 선으로 요일 구분, 본문 구분선은 검정. 7칸 높이는 하단 핸들로 한꺼번에 조절. */}
                    <div className="grid grid-cols-7">
                      {EXTRA_DAYS.map(([key, label], idx) => (
                        <div key={key} className="flex flex-col min-w-0">
                          <div className={`bg-gray-800 text-white text-center text-[11px] font-semibold py-0.5 ${idx > 0 ? "border-l border-white" : ""}`}>{label}</div>
                          <textarea
                            style={{ height: rowH }}
                            className={`w-full border-0 border-t border-black px-1.5 py-1 text-[12px] leading-snug text-center resize-none outline-none focus:bg-blue-50/40 disabled:opacity-60 ${idx > 0 ? "border-l" : ""}`}
                            value={ex[key] ?? ""}
                            onChange={(e) => setField(key, e.target.value)}
                            disabled={!isAdmin}
                          />
                        </div>
                      ))}
                    </div>
                    {isAdmin && (
                      <div
                        onPointerDown={(e) => startExtraResize(machine.id, e)}
                        title="드래그하여 7칸 높이 조절"
                        className="h-2 bg-gray-200 hover:bg-gray-300 cursor-row-resize flex items-center justify-center select-none touch-none"
                      >
                        <div className="w-8 h-0.5 bg-gray-400 rounded" />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>

      {/* 가운데: 1차 배정 (국/4×6/MB6/HDP 등 칸) — 제책 라인은 사용하지 않음 */}
      <div className={`w-[480px] bg-white shadow-sm flex flex-col overflow-hidden shrink-0 ${isJechae ? "hidden" : ""}`}>
        {/* 스크롤은 바깥에서 받고(스크롤바가 표 우측 테두리 바깥에 위치) 검정 테두리 표는 안쪽에 둔다 → 스크롤 생겨도 우측 라인 안 잘림 */}
        <div className="flex-1 overflow-y-auto">
        <div className="border border-black m-3">
        <div className="sticky top-0 z-10 px-3 py-3 border-b border-black bg-gray-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-900">1차 배정</h3>
            <p className="text-xs text-gray-500">{buckets.length}칸</p>
          </div>
          {isAdmin && (
          <div className="flex items-center gap-1">
            <button
              onClick={addBucket}
              className="px-2 py-1 bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
            >
              + 추가
            </button>
            <button
              onClick={() => setManageBuckets((v) => !v)}
              className={`px-2 py-1 text-xs border ${manageBuckets ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-300"}`}
            >
              관리
            </button>
          </div>
          )}
        </div>

        <div className="divide-y divide-black">
          {buckets.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-8">
              위 + 칸 버튼으로 1차 배정 칸을 추가하세요
            </div>
          ) : (
            buckets.map((b, idx) => {
              const bucketOrders = orders.filter((o) => showsAt(o, b.id));
              const isTarget = dropBucket === b.id;
              return (
                <div
                  key={b.id}
                  onDragOver={(e) => {
                    if (dragOrderId !== null || dragEntryId !== null || dragSplit !== null) {
                      e.preventDefault();
                      if (dropBucket !== b.id) setDropBucket(b.id);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node) && dropBucket === b.id) setDropBucket(null);
                  }}
                  onDrop={() => onDropOnBucket(b.id)}
                  className={isTarget ? "ring-2 ring-inset ring-blue-500 bg-blue-50/40" : ""}
                >
                  <div className="bg-gray-100 pl-4 pr-6 py-2 flex items-center justify-between border-b border-black">
                    {manageBuckets ? (
                      <input
                        defaultValue={b.name}
                        onBlur={(e) => renameBucket(b.id, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        className="text-sm font-bold border px-1 py-0.5 w-24"
                      />
                    ) : (
                      <span className="text-sm font-bold text-gray-800">{b.name}</span>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-gray-500">{fmtH(locationMinutes(bucketOrders, b.id))}</span>
                      {manageBuckets && (
                        <>
                          <button onClick={() => moveBucket(idx, -1)} disabled={idx === 0} className="text-gray-400 hover:text-gray-700 text-[10px] disabled:opacity-30" title="위로">▲</button>
                          <button onClick={() => moveBucket(idx, 1)} disabled={idx === buckets.length - 1} className="text-gray-400 hover:text-gray-700 text-[10px] disabled:opacity-30" title="아래로">▼</button>
                          <button onClick={() => deleteBucket(b)} className="text-red-400 hover:text-red-600 text-xs" title="칸 삭제">✕</button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="p-1.5 space-y-1 min-h-[12rem]">
                    {bucketOrders.length === 0 ? (
                      <div className="text-center text-gray-300 text-[11px] py-2">여기로 끌어다 1차 배정</div>
                    ) : (
                      bucketOrders.map((o) => renderOrderCard(o, b.id))
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        </div>
        </div>
      </div>

      {/* 우측: 배정 대기 주문 목록 */}
      <div
        className={`w-[480px] bg-white border shadow-sm flex flex-col overflow-hidden shrink-0 ${
          waitingDrop ? "ring-2 ring-red-400 bg-red-50/30" : ""
        }`}
        onDragOver={(e) => {
          if (dragSplit !== null || dragEntryId !== null || dragOrderId !== null) {
            e.preventDefault();
            if (!waitingDrop) setWaitingDrop(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setWaitingDrop(false);
        }}
        onDrop={() => { setWaitingDrop(false); onDropOnWaiting(); }}
      >
        <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-900">배정 대기</h3>
            <p className="text-xs text-gray-500">{fmtH(locationMinutes(waitingOrders, undefined))}</p>
          </div>
          {isAdmin && (
          <button
            onClick={() => (showAddForm ? resetForm() : (setEditingOrderId(null), setShowAddForm(true)))}
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
          >
            {showAddForm ? "닫기" : "+ 주문 추가"}
          </button>
          )}
        </div>

        {showAddForm && (
          <div className="p-3 border-b bg-blue-50/50">
            {editingOrderId !== null && (
              <p className="text-[11px] font-medium text-blue-700 mb-2">주문 수정 중</p>
            )}
            <form onSubmit={handleAddOrder} className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text" placeholder="제품명 *" required
                  className="border px-2 py-1.5 text-xs w-full"
                  value={newOrder.product_name}
                  onChange={(e) => setNewOrder({ ...newOrder, product_name: e.target.value })}
                />
                <input
                  type="text" placeholder="구성 (표지, 본문 등)"
                  className="border px-2 py-1.5 text-xs w-full"
                  value={newOrder.component}
                  onChange={(e) => setNewOrder({ ...newOrder, component: e.target.value })}
                />
                {/* 윤전·제책: 구분 대신 수량(윤전=수량(부), 제책=부수) 수기 입력. 매엽: 구분 입력. */}
                {usesQuantity ? (
                  isJechae ? (
                    <>
                      <div>
                        <label className="text-[10px] text-gray-500">부수</label>
                        <input
                          type="number" min="0" step="1" placeholder="부"
                          className="border px-2 py-1.5 text-xs w-full"
                          value={newOrder.quantity_sheets || ""}
                          onChange={(e) => {
                            const q = Number(e.target.value);
                            // 부수 변경 시 생산성이 있으면 소요시간 자동 계산
                            const d = calcDurationHours(q, newOrder.productivity);
                            setNewOrder({ ...newOrder, quantity_sheets: q, ...(d != null ? { duration_hours: d } : {}) });
                          }}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500">생산성 (부/시간)</label>
                        <input
                          type="number" min="0" step="1" placeholder="부/시간"
                          className="border px-2 py-1.5 text-xs w-full"
                          value={newOrder.productivity || ""}
                          onChange={(e) => {
                            const p = Number(e.target.value);
                            // 생산성 입력 시 부수 ÷ 생산성 = 소요시간 자동 입력
                            const d = calcDurationHours(newOrder.quantity_sheets, p);
                            setNewOrder({ ...newOrder, productivity: p, ...(d != null ? { duration_hours: d } : {}) });
                          }}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-500">구분 (배정 대기 분류)</label>
                        <select
                          className="border px-2 py-1.5 text-xs w-full"
                          value={(JECHAE_CATS as readonly string[]).includes(newOrder.special_process) ? newOrder.special_process : ""}
                          onChange={(e) => setNewOrder({ ...newOrder, special_process: e.target.value })}
                        >
                          <option value="">미지정</option>
                          {JECHAE_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </>
                  ) : (
                    // 윤전: 여러 구성일 때만 수량을 풀폭으로(단일 소요시간칸이 없으므로). 단일 구성은 소요시간 옆으로.
                    parseParts(newOrder.component).length >= 2 && (
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-500">수량 (부)</label>
                        <input
                          type="number" min="0" step="1" placeholder="부"
                          className="border px-2 py-1.5 text-xs w-full"
                          value={newOrder.quantity_sheets || ""}
                          onChange={(e) => setNewOrder({ ...newOrder, quantity_sheets: Number(e.target.value) })}
                        />
                      </div>
                    )
                  )
                ) : null}
                {(() => {
                  const newParts = parseParts(newOrder.component);
                  const multi = newParts.length >= 2;
                  return (
                    <>
                      {multi ? (
                        <div className="col-span-2">
                          {/* 윤전·제책은 구분 없이 구성·소요시간만, 매엽은 구성·소요시간·구분 */}
                          <div className={`grid ${usesQuantity ? "grid-cols-2" : "grid-cols-3"} gap-1 mb-1`}>
                            <span className="text-[10px] text-gray-500">구성</span>
                            <span className="text-[10px] text-gray-500">소요(시간)</span>
                            {!usesQuantity && <span className="text-[10px] text-gray-500">구분</span>}
                          </div>
                          <div className="space-y-1">
                            {newParts.map((p) => (
                              <div key={p} className={`grid ${usesQuantity ? "grid-cols-2" : "grid-cols-3"} gap-1 items-center`}>
                                <span className="text-[11px] text-gray-700 truncate" title={p}>{p}</span>
                                <input
                                  type="number" min="0" step="1" placeholder="시간"
                                  className="border px-2 py-1 text-xs w-full min-w-0"
                                  value={newOrder.partHours[p] || ""}
                                  onChange={(e) => setNewOrder({ ...newOrder, partHours: { ...newOrder.partHours, [p]: Number(e.target.value) } })}
                                />
                                {!usesQuantity && (
                                  <select
                                    className="border px-1 py-1 text-xs w-full min-w-0"
                                    value={newOrder.partProcesses[p] || newOrder.special_process}
                                    onChange={(e) => setNewOrder({ ...newOrder, partProcesses: { ...newOrder.partProcesses, [p]: e.target.value } })}
                                  >
                                    {PROCESSES.map((proc) => <option key={proc} value={proc}>{proc}</option>)}
                                  </select>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <>
                          <div>
                            <label className="text-[10px] text-gray-500">소요시간 (시간)</label>
                            <input
                              type="number" min="0" step="1" placeholder="자동"
                              className="border px-2 py-1.5 text-xs w-full"
                              value={newOrder.duration_hours || ""}
                              onChange={(e) => setNewOrder({ ...newOrder, duration_hours: Number(e.target.value) })}
                            />
                          </div>
                          {!usesQuantity && (
                            <div>
                              <label className="text-[10px] text-gray-500">구분</label>
                              <select
                                className="border px-2 py-1.5 text-xs w-full"
                                value={newOrder.special_process}
                                onChange={(e) => setNewOrder({ ...newOrder, special_process: e.target.value })}
                              >
                                <option value="">(공란)</option>
                                {PROCESSES.map((p) => <option key={p} value={p}>{p}</option>)}
                              </select>
                            </div>
                          )}
                          {isRoll && (
                            <div>
                              <label className="text-[10px] text-gray-500">수량 (부)</label>
                              <input
                                type="number" min="0" step="1" placeholder="부"
                                className="border px-2 py-1.5 text-xs w-full"
                                value={newOrder.quantity_sheets || ""}
                                onChange={(e) => setNewOrder({ ...newOrder, quantity_sheets: Number(e.target.value) })}
                              />
                            </div>
                          )}
                        </>
                      )}
                    </>
                  );
                })()}
                <input
                  type="text" placeholder="비고"
                  className="border px-2 py-1.5 text-xs w-full col-span-2"
                  value={newOrder.notes}
                  onChange={(e) => setNewOrder({ ...newOrder, notes: e.target.value })}
                />
              </div>
              <button type="submit" className="w-full py-1.5 bg-blue-600 text-white text-xs font-medium">
                {editingOrderId !== null ? "수정 저장" : "등록"}
              </button>
            </form>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {waitingOrders.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-8">
              대기 중인 주문이 없습니다
            </div>
          ) : isJechae ? (
            // 제책: 구분(무선/낙정/배접)별로 묶어 표시. 미지정은 맨 아래.
            [...JECHAE_CATS, ""].map((cat) => {
              const group = waitingOrders.filter((o) => ((JECHAE_CATS as readonly string[]).includes(o.special_process) ? o.special_process : "") === cat);
              if (group.length === 0) return null;
              return (
                <div key={cat || "none"} className="mb-2">
                  <div className="sticky top-0 z-10 px-2 py-1 text-[11px] font-bold text-gray-700 bg-gray-100 border-b">
                    {cat || "미지정"} <span className="font-normal text-gray-400">({group.length})</span>
                  </div>
                  <div className="space-y-1 mt-1">
                    {group.map((o) => renderOrderCard(o, undefined))}
                  </div>
                </div>
              );
            })
          ) : (
            waitingOrders.map((o) => renderOrderCard(o, undefined))
          )}
        </div>
      </div>
    </div>

    {/* 식사·휴게 시간 관리 모달. 추가/수정/삭제 시 서버가 전 설비 일정을 재계산한다. */}
    {showBreaks && (
      <div
        className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
        onClick={() => setShowBreaks(false)}
      >
        <div className="bg-white shadow-xl w-[440px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="px-4 py-3 border-b flex items-center justify-between bg-gray-50">
            <h3 className="font-bold text-gray-900">🍽 식사·휴게 시간</h3>
            <button onClick={() => setShowBreaks(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
          </div>
          <div className="p-3 space-y-2 overflow-y-auto">
            <p className="text-xs text-gray-500 leading-relaxed">
              여기 등록한 시간대에는 작업이 멈추는 것으로 보고 <b className="text-gray-700">예상완료시간 계산에서 자동으로 제외</b>됩니다.
              추가·수정·삭제하면 모든 기계의 완료시간이 다시 계산됩니다.
            </p>
            {breaks.length === 0 ? (
              <div className="text-sm text-gray-400 text-center py-4">등록된 식사시간이 없습니다</div>
            ) : (
              breaks.map((b) => (
                <div key={b.id} className="flex items-center gap-2 border p-2">
                  <input
                    defaultValue={b.name}
                    onBlur={(e) => { if (e.target.value !== b.name) updateBreak(b.id, { name: e.target.value }); }}
                    placeholder="이름"
                    className="border px-1.5 py-1 text-sm w-20"
                  />
                  <input
                    type="time"
                    defaultValue={minToHHMM(b.start_min)}
                    onBlur={(e) => { const v = hhmmToMin(e.target.value); if (v !== b.start_min) updateBreak(b.id, { start_min: v, end_min: b.end_min }); }}
                    className="border px-1.5 py-1 text-sm"
                  />
                  <span className="text-gray-400">~</span>
                  <input
                    type="time"
                    defaultValue={minToHHMM(b.end_min)}
                    onBlur={(e) => { const v = hhmmToMin(e.target.value); if (v !== b.end_min) updateBreak(b.id, { start_min: b.start_min, end_min: v }); }}
                    className="border px-1.5 py-1 text-sm"
                  />
                  <button onClick={() => deleteBreak(b.id)} className="ml-auto text-red-400 hover:text-red-600 text-sm" title="삭제">✕</button>
                </div>
              ))
            )}
            <button onClick={addBreak} className="w-full border border-dashed border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50">
              + 식사시간 추가
            </button>
          </div>
        </div>
      </div>
    )}

    {dtModalMachine !== null && (() => {
      const mac = machines.find((m) => m.id === dtModalMachine);
      const list = downtimes.filter((d) => d.machine_id === dtModalMachine).sort((a, b) => a.start_time.localeCompare(b.start_time));
      return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setDtModalMachine(null)}>
          <div className="bg-white shadow-xl w-[480px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b flex items-center justify-between bg-gray-50">
              <h3 className="font-bold text-gray-900">🛠 {mac?.name} 비가동시간</h3>
              <button onClick={() => setDtModalMachine(null)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
            </div>
            <div className="p-3 space-y-2 overflow-y-auto">
              <p className="text-xs text-gray-500 leading-relaxed">
                설비고장·교육훈련 등으로 <b className="text-gray-700">작업이 멈추는 시간대</b>를 등록하면, 그 시간만큼 이 설비의
                <b className="text-gray-700"> 예상완료시간이 자동으로 밀립니다.</b>
              </p>
              {list.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-3">등록된 비가동시간이 없습니다</div>
              ) : (
                list.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 border p-2 text-sm">
                    <span className="font-mono text-gray-700">{d.start_time}</span>
                    <span className="text-gray-400">~</span>
                    <span className="font-mono text-gray-700">{d.end_time}</span>
                    {d.reason && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs">{d.reason}</span>}
                    {isAdmin && <button onClick={() => deleteDowntime(d.id)} className="ml-auto text-red-400 hover:text-red-600" title="삭제">✕</button>}
                  </div>
                ))
              )}
              {isAdmin && (
                <div className="border-t pt-3 mt-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-9 shrink-0">시작</span>
                    <input type="datetime-local" value={dtForm.start} onChange={(e) => setDtForm((f) => ({ ...f, start: e.target.value }))} className="border px-1.5 py-1 text-sm flex-1" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-9 shrink-0">종료</span>
                    <input type="datetime-local" value={dtForm.end} onChange={(e) => setDtForm((f) => ({ ...f, end: e.target.value }))} className="border px-1.5 py-1 text-sm flex-1" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-9 shrink-0">사유</span>
                    <input type="text" value={dtForm.reason} onChange={(e) => setDtForm((f) => ({ ...f, reason: e.target.value }))} placeholder="예: 설비고장" className="border px-1.5 py-1 text-sm flex-1" />
                    {["설비고장", "교육훈련", "기타"].map((r) => (
                      <button key={r} type="button" onClick={() => setDtForm((f) => ({ ...f, reason: r }))} className="px-1.5 py-1 text-xs border bg-white hover:bg-gray-100 whitespace-nowrap">{r}</button>
                    ))}
                  </div>
                  <button onClick={() => addDowntime(dtModalMachine)} className="w-full border border-dashed border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50">+ 비가동시간 추가</button>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    })()}
    </div>
    </>
  );
}
