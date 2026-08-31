"use client";

import { useEffect, useState, useCallback, useRef, useMemo, Fragment } from "react";
import { useProcess } from "./components/ProcessContext";
import { useAuth } from "./components/AuthContext";
import { parseParts, parsePartDurations, parsePartProcesses, partTotals, parsePartBuckets } from "@/lib/parts";
import { parseDayShifts, parseDateShifts, isShiftMarker } from "@/lib/shifts";
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
  day_shifts?: string; // 요일별 근무체제 JSON {"1":["정상(주)","정상(야)"]}
  date_shifts?: string; // 일자별 예외 근무체제 JSON {"2026-07-27":["정상(주)"]}
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
  mark_color?: string; // 신규 주문 배정대기 표시색(rose). 확인 후 지움. 여러 사용자 공유.
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

// 표시색(mark_color) — 여러 관리자 공유, ''=표시 없음:
//   rose(핑크) = 설비 간 이동(자동) + #번호 클릭 수동 표시  /  amber(노랑) = 설비 내 순서변경(자동)
// #번호 클릭 시 rose(핑크) 켜기/끄기 토글.
const MARK_BG: Record<string, string> = {
  amber: "#fde68a", // 노랑(설비 내 순서변경 자동)
  rose: "#fbcfe8",  // 핑크(설비 간 이동 자동 + # 클릭 수동)
};
// 표시색을 엑셀 fill용 ARGB로 (#fde68a → FFFDE68A). 없으면 undefined.
const markArgb = (c?: string): string | undefined => (c && MARK_BG[c] ? "FF" + MARK_BG[c].slice(1).toUpperCase() : undefined);

// 제책 설비 하단 기타사항: 요일별(월~금) + 공통. extra_notes 컬럼에 JSON으로 저장.
const EXTRA_DAYS: [string, string][] = [["mon", "월"], ["tue", "화"], ["wed", "수"], ["thu", "목"], ["fri", "금"], ["sat", "토"], ["sun", "일"]];
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

// 예상완료 시간 칸: 한 줄 유지. 칸을 넘치면(줄바꿈 대신) 폰트를 줄여 맞춘다. 스크롤은 쓰지 않음.
function FitEndTime({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const MAX = 12, MIN = 8;
    let size = MAX;
    el.style.fontSize = size + "px";
    while (el.scrollWidth > el.clientWidth && size > MIN) {
      size -= 0.5;
      el.style.fontSize = size + "px";
    }
  }, [text]);
  return (
    <span ref={ref} className={className} style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", fontSize: "12px" }}>
      {text}
    </span>
  );
}

export default function ScheduleBoard() {
  const { processLine } = useProcess();
  // 현재 선택된 라인을 항상 가리키는 ref(비동기 fetch 완료 시 '지금도 같은 라인인지' 판별용).
  const processLineRef = useRef(processLine);
  processLineRef.current = processLine;
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
  // 윤전 제품명 뒤 표기: " * 수량". (요청: '대분' 표기는 빼고 제품명 * 수량만) 윤전만.
  const rollTag = (qty: number): string => {
    if (!isRoll) return "";
    return qty > 0 ? ` * ${qty.toLocaleString()}부` : "";
  };
  const [machines, setMachines] = useState<Machine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  // 전체 주문(대기·배정 완료 포함). 설비에 배정된 작업의 사양 편집에 사용.
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  // 되돌리기(Undo, 세션 방식): 각 라인별로 '변경 직전 상태' 스냅샷을 브라우저에 쌓아둔다.
  // fetchAll에서 상태가 실제로 바뀌면 직전 상태를 push하고, 되돌리기 시 서버로 복원한다.
  type UndoSnap = { orders: Order[]; entries: ScheduleEntry[]; buckets: Bucket[] };
  const undoStacksRef = useRef<Record<string, UndoSnap[]>>({});
  const committedRef = useRef<{ line: string; sig: string; orders: Order[]; entries: ScheduleEntry[]; buckets: Bucket[] } | null>(null);
  const suppressUndoPushRef = useRef(false); // 되돌리기로 인한 fetchAll에선 스냅샷을 쌓지 않게
  const [undoCount, setUndoCount] = useState(0); // 현재 라인의 되돌리기 가능 단계 수(버튼 활성화용)
  const UNDO_MAX = 30;
  // 현재 화면에 로드된 데이터가 어느 라인 것인지. processLine과 다르면(탭 전환 직후) 아직 이전 라인 데이터이므로
  // 설비·물량을 렌더하지 않고 로딩 표시 → 탭 전환 시 엉뚱한 라인 데이터가 잠깐 보이는 문제 방지.
  const [dataLine, setDataLine] = useState("");
  const [breaks, setBreaks] = useState<Break[]>([]);
  const [showBreaks, setShowBreaks] = useState(false);
  // [추가] 설비별 진행현황 요약(미리보기) 모달 표시 여부 — 기존 로직과 무관한 읽기 전용 화면.
  const [showSummary, setShowSummary] = useState(false);
  const [summaryFull, setSummaryFull] = useState(false); // 요약 모달 전체화면(최대화) 여부
  // 설비별 비가동시간(설비고장·교육훈련 등)
  const [downtimes, setDowntimes] = useState<Downtime[]>([]);
  const [dtModalMachine, setDtModalMachine] = useState<number | null>(null);
  const [dtForm, setDtForm] = useState({ start: "", end: "", reason: "" });
  // 완료책명 메모장(라인 공용, 자유 입력). workNote=저장값, showNote=모달 열림, noteDraft=편집 중 텍스트
  const [workNote, setWorkNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
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
  // 배정 대기 카드 순서 변경(위/아래 드래그)용 삽입 위치 표시
  const [waitReorderId, setWaitReorderId] = useState<number | null>(null);
  const [waitReorderAfter, setWaitReorderAfter] = useState(false);
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
  // 윤전 전용: 설비 배정 항목을 그 항목만(주문·다른 구역과 분리) 수정 중일 때의 엔트리 id.
  const [editRollEntryId, setEditRollEntryId] = useState<number | null>(null);
  // 매엽·제책: 설비 배정 항목에서 수정할 때 그 항목 id(비고를 '항목별'로 저장해 같은 주문의 다른 배정과 분리).
  const [editNotesEntryId, setEditNotesEntryId] = useState<number | null>(null);
  const [newOrder, setNewOrder] = useState({
    order_code: "", product_name: "", component: "", quantity_sheets: 0,
    deadline: "", special_process: "일반", priority: 5, notes: "", extra_notes: "", duration_hours: 0,
    productivity: 0, // 제책: 부/시간. 부수 ÷ 생산성 = 소요시간(시간)
    partHours: {} as Record<string, number>,
    partProcesses: {} as Record<string, string>,
    partQuantities: {} as Record<string, number>,
  });
  // 제책: 생산성 없이 소요시간 수동 입력. 구성이 여러 개면 부수를 구성별로 입력.
  const jechaeMulti = isJechae && parseParts(newOrder.component).length >= 2;
  // 구성 칩을 🗑로 끌어다 놓는 중인 행(완료·삭제 강조)
  const [trashOverEntry, setTrashOverEntry] = useState<number | null>(null);
  const dragOverMachine = useRef<number | null>(null);
  const [machineStartTimes, setMachineStartTimes] = useState<Record<number, string>>({});
  const [machineMemos, setMachineMemos] = useState<Record<number, string>>({});
  // 설비 블록 하단 기타사항(제책) 자유 입력
  const [machineExtras, setMachineExtras] = useState<Record<number, string>>({});
  // 인쇄 출력 종류: 'order'=기계별 작업순서표, 'full'=스케줄 전체 개요(기계계획+1차배정+대기)
  const [printView, setPrintView] = useState<"order" | "full">("order");
  const wantPrint = useRef(false);

  const fetchAll = useCallback(async () => {
    const line = processLine; // 이 fetch가 담당하는 라인
    const qs = `?process_line=${encodeURIComponent(line)}`;
    // 식사시간(breaks)은 전 공정 공통이라 process_line 필터 없이 받는다.
    const [machRes, orderRes, schedRes, bucketRes, breakRes, dtRes, noteRes] = await Promise.all([
      fetch(`/api/machines${qs}`), fetch(`/api/orders${qs}`), fetch(`/api/schedule${qs}`), fetch(`/api/buckets${qs}`), fetch(`/api/breaks`), fetch(`/api/downtimes`), fetch(`/api/worknote${qs}`),
    ]);
    const machData = await machRes.json();
    const orderData = await orderRes.json();
    const schedData = await schedRes.json();
    const bucketData = await bucketRes.json();
    const breakData = await breakRes.json();
    const dtData = await dtRes.json().catch(() => []);
    const noteData = await noteRes.json().catch(() => ({ note: "" }));
    // 응답이 도착했을 때 사용자가 이미 다른 탭으로 옮겼다면(느린/순서 뒤바뀐 응답) 이 데이터는 폐기한다.
    if (processLineRef.current !== line) return;
    setBreaks(Array.isArray(breakData) ? breakData : []);
    setDowntimes(Array.isArray(dtData) ? dtData : []);
    setWorkNote(typeof noteData?.note === "string" ? noteData.note : "");
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
      // 윤전은 대(구성)를 시간으로 쪼개 여러 설비에 나누지 않는다(한 대=한 설비). 그래서 설비에 '있는지'로만
      // 판단한다(소요시간이 주문값과 조금 달라도 대기로 뜨지 않게). 매엽은 시간 기준(부분 배정) 유지.
      if (isRoll) return parts.some((p) => !present.has(p));
      return parts.some((p) => { const t = Number(totals[p]) || 0; return t > 0 ? (alloc[p] || 0) < t : !present.has(p); });
    };
    // 되돌리기 스냅샷: 이 fetch로 상태가 실제로 바뀌면 '직전 상태'를 스택에 저장(세션 방식).
    const safeOrders: Order[] = Array.isArray(orderData) ? orderData : [];
    const safeBuckets: Bucket[] = Array.isArray(bucketData) ? bucketData : [];
    const newSig = JSON.stringify({ o: safeOrders, e: schedData, b: safeBuckets });
    const prevSnap = committedRef.current;
    if (suppressUndoPushRef.current) {
      suppressUndoPushRef.current = false; // 되돌리기가 유발한 fetch는 저장하지 않음(핑퐁 방지)
    } else if (prevSnap && prevSnap.line === line && prevSnap.sig !== newSig) {
      const stack = (undoStacksRef.current[line] = undoStacksRef.current[line] || []);
      stack.push({ orders: prevSnap.orders, entries: prevSnap.entries, buckets: prevSnap.buckets });
      if (stack.length > UNDO_MAX) stack.shift();
    }
    committedRef.current = { line, sig: newSig, orders: safeOrders, entries: schedData as ScheduleEntry[], buckets: safeBuckets };
    setUndoCount(undoStacksRef.current[line]?.length || 0);
    setOrders(orderData.filter((o: Order) => o.status === "pending" || orderHasRemaining(o)));
    setAllOrders(safeOrders);
    setSchedule(schedData);
    setBuckets(safeBuckets);
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
    setDataLine(line); // 이 라인 데이터 로드 완료 → 렌더 허용
  }, [processLine]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // 로드된 데이터가 현재 탭(라인)과 일치할 때만 설비·물량을 렌더한다(탭 전환 직후 이전 라인 데이터 노출 방지).
  const linesReady = dataLine === processLine;

  // 드래그 중 화면 위/아래 가장자리에 커서가 가면 설비 목록을 자동 스크롤(맨 아래→맨 위 설비로도 옮길 수 있게).
  const listScrollRef = useRef<HTMLDivElement>(null);
  const waitListRef = useRef<HTMLDivElement>(null); // 배정 대기 스크롤 컨테이너(순서변경 중 자동스크롤 대상)
  const summaryRef = useRef<HTMLDivElement>(null); // 진행현황 요약 모달 본문(제품명·비고 폰트 자동 축소 대상)
  // 진행현황 요약: 제품명/비고가 한 줄을 넘치면 줄바꿈 대신 폰트를 자동 축소해 한 줄로 맞춘다.
  // (칸이 넓어 대부분 기본 크기 유지, 아주 긴 항목만 살짝 줄어듦. 최소 7px)
  useEffect(() => {
    if (!showSummary) return;
    const run = () => {
      const root = summaryRef.current;
      if (!root) return;
      root.querySelectorAll<HTMLElement>(".sm-fit").forEach((el) => {
        el.style.fontSize = ""; // 기준 크기로 리셋 후 다시 측정
        const avail = el.clientWidth;
        const content = el.scrollWidth;
        if (avail > 0 && content > avail + 1) {
          const base = parseFloat(getComputedStyle(el).fontSize) || 12;
          const size = Math.max(7, Math.floor((base * avail) / content * 10) / 10);
          el.style.fontSize = `${size}px`;
        }
      });
    };
    const raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [showSummary, summaryFull, machines, schedule, processLine]);
  // 배정 대기 순서변경 드래그 중 커서가 배정 대기 패널 위에 있는지 (그동안 다른 열은 세로 스크롤 잠금 → 엉뚱한 열이 안 올라가게)
  const [overWaitPanel, setOverWaitPanel] = useState(false);
  const dragPointerY = useRef<number | null>(null);
  const overWaitPanelRef = useRef(false); // RAF 루프에서 참조: 배정 대기 순서변경 중엔 설비열 자동스크롤 금지
  useEffect(() => { overWaitPanelRef.current = overWaitPanel; }, [overWaitPanel]);
  useEffect(() => {
    let raf = 0;
    const onOver = (e: DragEvent) => { dragPointerY.current = e.clientY; };
    const onEnd = () => { dragPointerY.current = null; };
    const loop = () => {
      const y = dragPointerY.current;
      // 배정 대기 카드 순서변경 중이면 '배정 대기 목록'을, 그 외엔 '설비(기계별 작업계획) 열'을 자동 스크롤.
      const el = overWaitPanelRef.current ? waitListRef.current : listScrollRef.current;
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
    const bkItems = root.querySelectorAll<HTMLElement>(".pf-bk-item"); // 1차 배정 칸 항목(2열)
    if (!lis.length && !rows.length && !bkItems.length) return;
    const PXMM = 96 / 25.4;          // 1mm → px (96dpi)
    const BASE_PT = 7;               // 배정 내역 기본 폰트(축소)
    const ETA_PT = BASE_PT + 3;      // 예상완료(완료시간)만 크게(요청) = 10pt
    const LIST_W = 90 * PXMM;        // 인쇄 시 박스 내부(작업 목록) 가용 폭 ≈ 90mm 고정
    const GAP = 1.5 * PXMM;          // 칸 사이 간격
    const SAFETY = 1.5 * PXMM;       // 반올림 줄바꿈 방지 여백
    const NUM_W = 5 * PXMM;          // 맨 앞 번호 칸(≈5mm)
    const usable = LIST_W - NUM_W - 3 * GAP; // 번호+제품명+비고+완료 4칸·3간격
    // 열 비율은 CSS .pf-li(매엽·윤전 공통=48/16.4/15.6)와 일치시킨다. (예상완료 칸 추가 ~5px 확대: 비고에서 1.3fr 더 이동)
    const R = { job: 48, note: 16.4, eta: 15.6, tot: 80 };
    const JOB_W = usable * R.job / R.tot - SAFETY;   // 제품명 칸
    const NOTE_W = usable * R.note / R.tot - SAFETY; // 비고 칸
    const ETA_W = usable * R.eta / R.tot - SAFETY;   // 완료 칸(좁음 → 글자 자동 축소)
    const WAIT_W = 44 * PXMM;               // 배정 대기 2열 한 칸 폭 ≈ 44mm
    const BK_W = 44 * PXMM;                 // 1차 배정 2열 한 칸 내부 폭 ≈ 44mm
    const ref = lis[0]?.querySelector<HTMLElement>(".pf-job") ?? rows[0] ?? document.body;
    const cs = getComputedStyle(ref);
    const meas = document.createElement("span");
    meas.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;";
    meas.style.fontFamily = cs.fontFamily;
    meas.style.fontWeight = cs.fontWeight;
    meas.style.fontSize = `${(BASE_PT * 96) / 72}px`;
    document.body.appendChild(meas);
    // basePt: 측정·축소 기준 폰트(기본 BASE_PT). eta만 ETA_PT(=BASE_PT+2)로 크게 표기.
    const fit = (el: HTMLElement | null, colW: number, basePt = BASE_PT) => {
      if (!el) return;
      meas.style.fontSize = `${(basePt * 96) / 72}px`;
      meas.textContent = el.textContent || "";
      const w = meas.getBoundingClientRect().width;
      el.style.fontSize = w > colW && colW > 0
        ? `${Math.max(3, Math.round((basePt * colW) / w * 10) / 10)}pt`
        : (basePt === BASE_PT ? "" : `${basePt}pt`);
    };
    lis.forEach((li) => {
      fit(li.querySelector<HTMLElement>(".pf-job"), JOB_W);
      fit(li.querySelector<HTMLElement>(".pf-note"), NOTE_W);
      fit(li.querySelector<HTMLElement>(".pf-eta"), ETA_W, ETA_PT);
    });
    rows.forEach((el) => fit(el, WAIT_W));
    bkItems.forEach((el) => fit(el, BK_W));
    document.body.removeChild(meas);
  }, [schedule, machines, buckets, orders, printView, isJechae]);

  // 제책 양식 인쇄: 작업명이 칸 폭을 넘으면 줄바꿈 대신 폰트를 실측해 유동 축소(한 줄 유지).
  // (비고는 줄바꿈 허용 — 축소하지 않음)
  useEffect(() => {
    if (printView !== "full" || !isJechae) return;
    const root = document.querySelector(".print-area");
    if (!root) return;
    const jobs = root.querySelectorAll<HTMLElement>(".jml-job");
    if (!jobs.length) return;
    const PXMM = 96 / 25.4;
    const BASE_PT = 10;
    const LAND_W = 281;            // 가로 A4 가용 폭(mm, 여백 8mm 제외)
    const PAD = 3 * PXMM;          // 셀 좌우 패딩(1.5mm×2)
    const JOB_W = LAND_W * 0.352 * PXMM - PAD;  // 작업명 칸(35.2%)
    const cs = getComputedStyle(jobs[0]);
    const meas = document.createElement("span");
    meas.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;";
    meas.style.fontFamily = cs.fontFamily;
    meas.style.fontWeight = cs.fontWeight;
    meas.style.fontSize = `${(BASE_PT * 96) / 72}px`;
    document.body.appendChild(meas);
    jobs.forEach((el) => {
      el.style.fontSize = "";
      meas.textContent = el.textContent || "";
      const w = meas.getBoundingClientRect().width;
      el.style.fontSize = w > JOB_W && JOB_W > 0 ? `${Math.max(4, Math.round((BASE_PT * JOB_W) / w * 10) / 10)}pt` : "";
    });
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

  // #번호 클릭 → 표시 색상 토글(없음 ↔ 노랑). DB 저장으로 여러 관리자 공유.
  // #번호 클릭: 표시색 rose(핑크) 켜기/끄기 토글(수동 표시 — 모든 관리자 공유).
  // 이미 핑크면 지우고, 그 외(표시 없음·노랑)면 핑크로 칠한다.
  const cycleMark = async (entry: ScheduleEntry) => {
    if (!isAdmin) return;
    const next = entry.mark_color === "rose" ? "" : "rose";
    setSchedule((prev) => prev.map((e) => (e.id === entry.id ? { ...e, mark_color: next } : e)));
    await fetch("/api/schedule/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entry.id, color: next }),
    });
  };

  // 신규 주문(배정대기) 분홍 표시 '확인'(지우기) — 여러 사용자 공유. 낙관적 갱신 후 서버 반영.
  const clearOrderMark = async (order: Order) => {
    if (!isAdmin || !order.mark_color) return;
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, mark_color: "" } : o)));
    setAllOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, mark_color: "" } : o)));
    await fetch(`/api/orders/${order.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark_color: "" }),
    });
  };

  // 완료책명 메모장(라인 공용) 열기/저장. 관리자는 편집, 그 외는 확인만.
  const openNote = () => { setNoteDraft(workNote); setShowNote(true); };
  const saveNote = async () => {
    const text = noteDraft;
    setWorkNote(text);
    setShowNote(false);
    await fetch("/api/worknote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ process_line: processLine, note: text }),
    });
  };

  // 변경된 항목을 자동으로 표시색으로 칠한다(관리자 식별용).
  //   color="rose"(핑크)=설비 간 이동(기본)  /  color="amber"(노랑)=설비 내 순서변경
  // 그 주문이 대상 설비에 만든/바뀐 엔트리를 칠한다(이동은 새 엔트리가 생기므로 다시 조회해 찾는다).
  const markMoved = async (orderId: number | null, machineId: number, color: string = "rose") => {
    if (!isAdmin || orderId == null) return;
    try {
      const sch = await fetch(`/api/schedule?process_line=${encodeURIComponent(processLine)}`).then((r) => r.json());
      if (!Array.isArray(sch)) return;
      const ids = (sch as ScheduleEntry[]).filter((e) => e.order_id === orderId && e.machine_id === machineId).map((e) => e.id);
      if (!ids.length) return;
      setSchedule((prev) => prev.map((e) => (ids.includes(e.id) ? { ...e, mark_color: color } : e)));
      await Promise.all(ids.map((id) => fetch("/api/schedule/mark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry_id: id, color }) })));
    } catch { /* 무시 */ }
  };

  // 되돌리기(Undo): 현재 라인의 스택에서 '직전 상태'를 꺼내 서버로 복원한다.
  const undo = async () => {
    if (!isAdmin) return;
    const line = processLine;
    const stack = undoStacksRef.current[line];
    if (!stack || stack.length === 0) return;
    const snap = stack.pop()!;
    setUndoCount(stack.length);
    setLoading(true);
    suppressUndoPushRef.current = true; // 복원 후의 fetchAll이 되돌린 상태를 다시 쌓지 않게
    try {
      const res = await fetch("/api/schedule/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ process_line: line, orders: snap.orders, entries: snap.entries, buckets: snap.buckets }),
      });
      if (!res.ok) { suppressUndoPushRef.current = false; stack.push(snap); setUndoCount(stack.length); }
      await fetchAll();
    } catch {
      suppressUndoPushRef.current = false;
    } finally {
      setLoading(false);
    }
  };
  const undoRef = useRef(undo);
  undoRef.current = undo;
  // Ctrl+Z 되돌리기 (입력창에 포커스된 경우는 브라우저 기본 실행취소를 방해하지 않음)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      e.preventDefault();
      undoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 탭(라인) 전환 시 그 라인의 되돌리기 가능 단계 수를 즉시 반영
  useEffect(() => { setUndoCount(undoStacksRef.current[processLine]?.length || 0); }, [processLine]);

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
    // 같은 설비 내 재배치=순서변경(노랑), 다른 설비로 이동=이동(분홍).
    await markMoved(movedOid, targetMachineId, srcMachineId === targetMachineId ? "amber" : "rose");
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

  // === 위치별 독립 삭제 (확인창 없음) ===
  // 설비 배정 / 1차 배정 칸 / 배정 대기를 각각 '그 위치의 것'만 제거한다. 한 곳을 지워도 다른 곳은 유지.
  const deleteWholeOrder = async (orderId: number) => {
    setLoading(true);
    await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
    await fetchAll();
    setLoading(false);
  };

  // 설비 배정 항목 삭제: 그 설비의 배정만 제거(다른 설비·1차 배정·대기 구성은 유지).
  const handleDeleteEntry = async (entry: ScheduleEntry) => {
    setLoading(true);
    await fetch("/api/schedule/delete-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_id: entry.id }),
    });
    await fetchAll();
    setLoading(false);
  };

  // 카드 삭제(배정 대기=bucketId undefined / 1차 배정 칸=bucketId): 그 위치에 보이는 구성만 제거.
  // 설비에 배정된 구성·다른 위치 구성은 유지. 단일/무구성 주문은 한 곳에만 있으므로 주문 삭제.
  const handleDeleteCardLocation = async (order: Order, bucketId?: number) => {
    const parts = parseParts(order.component);
    if (parts.length < 2) return deleteWholeOrder(order.id);
    const locParts = partsAtLocation(order, bucketId);
    const totals = partTotals(order.component, order.part_durations, order.duration_minutes);
    const alloc: Record<string, number> = {};
    for (const s of schedule) {
      if (s.order_id !== order.id) continue;
      for (const [p, m] of Object.entries(parsePartDurations(s.part_durations))) alloc[p] = (alloc[p] || 0) + (Number(m) || 0);
    }
    const keep: Record<string, number> = {};
    for (const p of parts) {
      if (locParts.includes(p)) {
        // 이 위치 구성: 일부라도 설비 배정돼 있으면 배정분만 유지, 아니면 제거.
        if ((alloc[p] || 0) > 0) keep[p] = alloc[p];
      } else {
        keep[p] = Number(totals[p]) || 0; // 다른 위치(설비 배정·다른 칸) 구성은 유지.
      }
    }
    if (Object.keys(keep).length === 0) return deleteWholeOrder(order.id);
    setLoading(true);
    await fetch(`/api/orders/${order.id}/drop-waiting`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep }),
    });
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
    await markMoved(movedOid, machineId, "amber"); // 설비 내 순서변경 = 노랑
  };

  // 배정 대기 카드 순서 변경(위/아래 드래그). orderedIds = 재정렬 대상 주문 id들의 새 순서.
  const handleReorderWaiting = async (orderedIds: number[]) => {
    // 낙관적 갱신: 대기 슬롯 위치에 새 순서대로 카드를 끼워넣어 즉시 반영.
    const idSet = new Set(orderedIds);
    setOrders((prev) => {
      const byId = new Map(prev.map((o) => [o.id, o] as const));
      const seq = orderedIds.map((id) => byId.get(id)).filter(Boolean) as Order[];
      let i = 0;
      return prev.map((o) => (idSet.has(o.id) ? seq[i++] : o));
    });
    await fetch("/api/orders/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: orderedIds, process_line: processLine }),
    });
    await fetchAll();
  };

  // 지금 '배정 대기 카드 전체'를 순서 변경 목적으로 끌고 있는가 (부분 칩·설비 드래그·1차배정 카드가 아님)
  const isReorderingWaitCard = (): boolean =>
    dragOrderId !== null && !dragPart && dragEntryId === null && dragSplit === null && waitingOrders.some((o) => o.id === dragOrderId);
  // 커서 Y로 삽입 위치(어느 카드 앞/뒤)를 계산. 카드 사이 빈 공간·목록 위아래 끝에서도 동작.
  const waitInsertAt = (container: HTMLElement, clientY: number): { targetId: number | null; after: boolean } => {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-oid]")).filter((c) => Number(c.dataset.oid) !== dragOrderId);
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return { targetId: Number(c.dataset.oid), after: false };
    }
    return { targetId: cards.length ? Number(cards[cards.length - 1].dataset.oid) : null, after: true };
  };
  const dropWaitReorder = (targetId: number | null, after: boolean) => {
    if (dragOrderId === null) return;
    const ids = waitingOrders.map((o) => o.id).filter((id) => id !== dragOrderId);
    let idx: number;
    if (targetId === null) idx = ids.length;
    else { idx = ids.indexOf(targetId); if (idx < 0) idx = ids.length; else if (after) idx += 1; }
    ids.splice(idx, 0, dragOrderId);
    setWaitReorderId(null);
    clearDragState();
    handleReorderWaiting(ids);
  };
  // 배정 대기 목록/그룹 컨테이너에 붙이는 순서변경 DnD 핸들러 (카드 사이·위아래 끝 어디에 놓아도 동작)
  const waitReorderDnd = isAdmin ? {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!isReorderingWaitCard()) return; // 설비/1차배정 이동·배정취소 드래그는 그대로 흘려보냄
      e.preventDefault();
      e.stopPropagation();
      if (!overWaitPanel) setOverWaitPanel(true); // 다른 열 세로 스크롤 잠금 + RAF 루프가 배정 대기 목록을 자동 스크롤
      const t = waitInsertAt(e.currentTarget, e.clientY);
      setWaitReorderId((prev) => (prev === t.targetId ? prev : t.targetId));
      setWaitReorderAfter((prev) => (prev === t.after ? prev : t.after));
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (!isReorderingWaitCard()) return;
      e.preventDefault();
      e.stopPropagation();
      const t = waitInsertAt(e.currentTarget, e.clientY);
      dropWaitReorder(t.targetId, t.after);
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setWaitReorderId(null);
    },
  } : {};

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
    setEditRollEntryId(null);
    setEditNotesEntryId(null);
  };

  // 대기 주문 편집 시작: 폼을 해당 주문 값으로 채운다
  // asCopy=true면 같은 사양으로 '새 주문'을 만든다(값만 채우고 editingOrderId는 비움 → 저장 시 신규 생성).
  // 한 제품을 생산하다 중단·다른 제품 후 이어서 생산하는 계획에서, 다시 입력하지 않고 분량만 고쳐 배정할 수 있다.
  const startEditOrder = (order: Order, asCopy = false, fromMachineId: number | null = null, entry: ScheduleEntry | null = null) => {
    // 윤전: 설비 행에서 수정하면 '그 설비 배정 항목'만 고친다(주문·1차배정·대기와 분리). 자체 표시값(제품명·비고·수량·소요)만 편집.
    if (isRoll && !asCopy && entry != null) {
      // 이 항목이 실제로 가진 구성(entry.component_part)만 보여준다. 구성 없으면 통째(단일 소요시간).
      const eparts = parseParts(entry.component_part);
      const epd = parsePartDurations(entry.part_durations);
      const ePartHours: Record<string, number> = {};
      for (const p of eparts) ePartHours[p] = Math.round((Number(epd[p]) || 0) / 60 * 2) / 2;
      setNewOrder({
        order_code: order.order_code || "",
        product_name: entry.product_name || order.product_name,
        component: entry.component_part || "",
        quantity_sheets: entry.quantity_sheets || 0,
        deadline: order.deadline || "",
        special_process: "",
        priority: order.priority || 5,
        notes: entry.order_notes || "",
        extra_notes: order.extra_notes || "",
        duration_hours: eparts.length >= 2 ? 0 : Math.round((entry.duration_minutes || 0) / 60 * 2) / 2,
        productivity: 0,
        partHours: ePartHours,
        partProcesses: {},
        partQuantities: {},
      });
      setEditingOrderId(order.id);
      setEditMachineId(fromMachineId);
      setEditEntryId(null);
      setEditEntryParts([]);
      setEditRollEntryId(entry.id);
      setEditNotesEntryId(null); // 윤전은 entry-fields가 비고까지 항목별로 저장
      setShowAddForm(true);
      return;
    }
    // 설비 행에서 수정하면 '그 설비 배정 항목(엔트리)의 구성'을 기준으로 편집한다(폼=칩과 일치, 저장 시 교체).
    // 주문 구성과 설비 항목 구성이 어긋나 있어도 설비 항목을 그대로 불러오므로 표시 불일치가 없다.
    const scoped = !asCopy && entry != null && parseParts(entry.component_part).length >= 1;
    const parts = scoped ? parseParts(entry!.component_part) : parseParts(order.component);
    const pd = parsePartDurations(scoped ? entry!.part_durations : order.part_durations);
    const pp = parsePartProcesses(order.part_processes);
    const pq = parsePartDurations(order.part_quantities);
    const partHours: Record<string, number> = {};
    const partProcesses: Record<string, string> = {};
    const partQuantities: Record<string, number> = {};
    for (const p of parts) {
      partHours[p] = Math.round((Number(pd[p]) || 0) / 60 * 2) / 2;
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
      // 설비 항목에서 수정하면 그 '항목의 비고'를 폼에 채운다(entry.order_notes). 대기 주문 편집이면 주문 비고.
      notes: entry != null ? (entry.order_notes || "") : (order.notes || ""),
      extra_notes: order.extra_notes || "",
      duration_hours: parts.length >= 2 ? 0 : (scoped ? Math.round((Number(pd[parts[0]]) || 0) / 60 * 2) / 2 : Math.round((order.duration_minutes || 0) / 60 * 2) / 2),
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
    // 설비 항목에서 수정하면 비고를 '그 항목'에 저장(같은 주문의 다른 배정과 분리). 복사/대기 편집이면 주문 비고.
    setEditNotesEntryId(!asCopy && entry != null ? entry.id : null);
    setShowAddForm(true);
  };

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    // 윤전 설비 항목 수정: 원본 주문은 건드리지 않고 그 배정 항목의 자체 표시값만 갱신(구역 독립).
    if (isRoll && editRollEntryId !== null) {
      const ep = parseParts(newOrder.component);
      // 설비 항목 수정에서는 '새 구성'만 추가할 수 있다. 이미 배정 대기(주문)나 다른 설비에 있는 구성을
      // 여기서 타이핑해 넣으면 그 구성이 그쪽에서 빠져(합쳐져) 버리므로, 그런 입력은 막고 드래그로 옮기게 한다.
      const origEntry = schedule.find((s) => s.id === editRollEntryId);
      const origParts = parseParts(origEntry?.component_part || "");
      const added = ep.filter((p) => !origParts.includes(p));
      const ord = allOrders.find((o) => o.id === editingOrderId);
      const orderParts = parseParts(ord?.component || "");
      const otherEntryParts = new Set<string>();
      for (const s of schedule) {
        if (s.order_id === editingOrderId && s.id !== editRollEntryId) parseParts(s.component_part).forEach((p) => otherEntryParts.add(p));
      }
      const conflict = added.filter((p) => orderParts.includes(p) || otherEntryParts.has(p));
      if (conflict.length > 0) {
        window.alert(`'${conflict.join(", ")}' 구성은 이미 배정 대기(또는 다른 설비)에 있습니다.\n설비로 옮기려면 그 구성을 드래그하세요. (설비 수정에서는 새 구성만 추가할 수 있습니다.)`);
        return;
      }
      // 구성별 소요시간: 여러 개면 파트별 입력값, 단일이면 전체 소요시간칸 값을 그 구성에 적용.
      const partsPayload = ep.map((p) => ({
        name: p,
        minutes: ep.length >= 2
          ? Math.round((newOrder.partHours[p] || 0) * 60)
          : Math.round((newOrder.duration_hours || 0) * 60),
      }));
      const durMin = ep.length >= 2
        ? partsPayload.reduce((s, x) => s + x.minutes, 0)
        : Math.round((newOrder.duration_hours || 0) * 60);
      await fetch("/api/schedule/entry-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_id: editRollEntryId,
          product_name: newOrder.product_name,
          notes: newOrder.notes,
          quantity_sheets: newOrder.quantity_sheets || 0,
          duration_minutes: durMin,
          parts: partsPayload,
        }),
      });
      const mid = editMachineId;
      const oid = editingOrderId;
      resetForm();
      await fetchAll();
      if (oid !== null && mid !== null) await markMoved(oid, mid);
      return;
    }
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
    // 제책: 구성별 부수(part_quantities). 다구성이면 표의 구성별 부수, 단일이면 부수칸 값을 그 구성에.
    // 전체 부수(quantity_sheets)는 구성별 부수의 합으로 저장(표시·하위호환).
    const partQuantities: Record<string, number> = {};
    if (isJechae) {
      if (parts.length >= 2) for (const p of parts) partQuantities[p] = Number(newOrder.partQuantities[p]) || 0;
      else if (parts.length === 1) partQuantities[parts[0]] = newOrder.quantity_sheets || 0;
    }
    const qtyTotal = (isJechae && parts.length >= 2)
      ? Object.values(partQuantities).reduce((a, b) => a + b, 0)
      : newOrder.quantity_sheets;
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
      // 주문에 남길 구성(kept): 이 설비 항목의 옛 구성은 폼값으로 교체되므로 뺀다.
      // - 다른 설비에 실제로 있는 구성: 유지
      // - 어느 설비에도 없는 구성: 아직 미배정(pending)이면 대기 구성으로 유지, 이미 전량 배정(scheduled)이면
      //   설비 항목과 어긋난 옛 잔재로 보고 버린다(빈칸에 유령 구성이 생기지 않게).
      const otherEntryParts = new Set<string>();
      for (const s of schedule) {
        if (s.order_id === editingOrderId && s.id !== editEntryId) parseParts(s.component_part).forEach((p) => otherEntryParts.add(p));
      }
      const kept = origParts.filter((p) => {
        if (editEntryParts.includes(p)) return false;
        if (otherEntryParts.has(p)) return true;
        return existingStatus !== "scheduled";
      });
      const mergedComp = [...kept, ...parts.filter((p) => !kept.includes(p))];
      const mergedPD: Record<string, number> = {};
      const mergedPP: Record<string, string> = {};
      for (const p of kept) { mergedPD[p] = Number(origPD[p]) || 0; mergedPP[p] = origPP[p] || ""; }
      for (const p of parts) { mergedPD[p] = minutesOf(p); mergedPP[p] = partProcesses[p] ?? ""; }
      // 제책: 구성별 부수도 병합(다른 설비/대기 구성의 부수는 원본 유지, 이 항목 구성은 폼값). 아니면 원본 그대로.
      const origPQ = parsePartDurations(origOrder?.part_quantities);
      const mergedPQ: Record<string, number> = {};
      if (isJechae) {
        for (const p of kept) mergedPQ[p] = Number(origPQ[p]) || 0;
        for (const p of parts) mergedPQ[p] = parts.length >= 2 ? (Number(newOrder.partQuantities[p]) || 0) : (newOrder.quantity_sheets || 0);
      }
      const mergedQty = isJechae ? Object.values(mergedPQ).reduce((a, b) => a + b, 0) : newOrder.quantity_sheets;
      await fetch(`/api/orders/${editingOrderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          // 설비 항목에서 수정 시 비고는 '주문'을 건드리지 않는다(항목별 저장). 대기 편집이면 폼값 사용.
          notes: editNotesEntryId != null ? (origOrder?.notes ?? "") : newOrder.notes,
          component: mergedComp.join(", "),
          special_process: specialProcess,
          quantity_sheets: mergedQty,
          duration_minutes: Object.values(mergedPD).reduce((a, b) => a + b, 0),
          part_durations: mergedPD,
          part_processes: mergedPP,
          part_quantities: isJechae ? mergedPQ : {},
          status: existingStatus,
        }),
      });
      await fetch("/api/schedule/set-entry-parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry_id: editEntryId, parts: parts.map((p) => ({ name: p, minutes: minutesOf(p) })) }),
      });
      // 비고는 이 설비 항목에만 저장(같은 주문의 다른 배정과 분리).
      if (editNotesEntryId != null) {
        await fetch("/api/schedule/entry-notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry_id: editNotesEntryId, notes: newOrder.notes }),
        });
      }
    } else if (editingOrderId !== null) {
      // 배정 완료된 작업을 설비 화면에서 수정해도 상태가 대기로 바뀌지 않도록 기존 상태 유지
      const origOrderFull = allOrders.find((o) => o.id === editingOrderId);
      const existingStatus = origOrderFull?.status || "pending";
      await fetch(`/api/orders/${editingOrderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          // 설비 항목에서 수정 시 비고는 '주문'을 건드리지 않는다(항목별 저장). 대기 편집이면 폼값 사용.
          notes: editNotesEntryId != null ? (origOrderFull?.notes ?? "") : newOrder.notes,
          special_process: specialProcess,
          quantity_sheets: qtyTotal,
          duration_minutes: durationMinutes,
          part_durations: partDurations,
          part_processes: partProcesses,
          part_quantities: partQuantities,
          status: existingStatus,
        }),
      });
      // 배정대기에서 '기존 주문'을 수정하면 노랑(amber)으로 표시 → 다른 사용자가 '수정됨'을 알아보게.
      // (설비 항목에서 수정한 경우 editMachineId가 있으므로 제외 — 그건 주문 자체 편집이 아님)
      if (editMachineId === null) {
        await fetch(`/api/orders/${editingOrderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mark_color: "amber" }),
        });
      }
      // 비고는 이 설비 항목에만 저장(같은 주문의 다른 배정과 분리).
      if (editNotesEntryId != null) {
        await fetch("/api/schedule/entry-notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry_id: editNotesEntryId, notes: newOrder.notes }),
        });
      }
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
          quantity_sheets: qtyTotal,
          duration_minutes: durationMinutes,
          part_durations: partDurations,
          part_processes: partProcesses,
          part_quantities: partQuantities,
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
    if (overWaitPanel) setOverWaitPanel(false); // 설비 위로 오면 설비 열 스크롤 잠금 해제(먼 설비로 배정 가능)
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
    setOverWaitPanel(false);
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
    // 윤전은 대(구성)를 시간으로 분할하지 않으므로 '설비에 있으면 배정됨'으로만 본다(소요시간 차이로 대기에 뜨지 않게).
    if (isRoll) return parts.filter((p) => !present.has(p));
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
  // 위치(대기=undefined / 칸=bucketId)에 '실제로 남아 있는 구성'만 표기 — 화면 카드와 일치시킨다.
  // (전체 component가 아니라, 그 위치에 남은 구성만. 구성 없는 주문은 통째로 표기.)
  const waitLabel = (o: Order, bucketId?: number) => {
    const hasParts = parseParts(o.component).length > 0;
    const comp = hasParts ? partsAtLocation(o, bucketId).join(", ") : o.component;
    return `${o.product_name}${comp ? `(${comp})` : ""}${o.quantity_sheets ? ` = ${o.quantity_sheets.toLocaleString()}부` : ""}`;
  };

  // 분 → "N.Nh" (소요시간 합계 표기)
  const fmtH = (min: number) => `${Math.round(min / 6) / 10}h`;
  // 분 → "N.N일" (일수 = 총 배정시간 ÷ 10개조 ÷ 10시간 = 분/6000, 소수점 1자리)
  const fmtDays = (min: number) => `${Math.round(min / 600) / 10}일`;

  // 제책 '설비별 작업 목록'(첨부 양식용). 각 설비의 배정 순서대로 작업명·소요(시간)·예상완료·비고 행.
  // 배정이 없으면 rows는 빈 배열(양식에선 빈 줄 1개로 설비명만 표시).
  type JmRow = { job: string; hours: number | ""; eta: string; note: string; mark: string };
  const jechaeMachineRows = (): { machine: Machine; rows: JmRow[] }[] =>
    machines.map((m) => ({
      machine: m,
      rows: getEntriesForMachine(m.id).map((e) => {
        const comp = e.component_part || e.component || "";
        const qty = e.quantity_sheets ? ` = ${e.quantity_sheets.toLocaleString()}부` : "";
        return {
          job: `${e.product_name}${comp ? `(${comp})` : ""}${qty}`,
          hours: e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : "",
          eta: e.end_time ? formatEndTime(e.end_time) : "",
          note: (e.order_notes || "").trim(),
          mark: e.mark_color || "",
        } as JmRow;
      }),
    }));

  const downloadExcel = async () => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    if (isJechae) {
      // 제책 양식(첨부 파일 기준): 30열 세밀 그리드에 셀 병합으로 두 표를 같은 격자에 정렬.
      //  · 상단 '설비별 요일 근무체제' : 설비(A:B) + 각 요일 4열씩 균등(월 C:F … 일 AA:AD), 네이비 헤더.
      //  · '제책 작업 계획' : 설비명(A:B) no.(C) 작업명(D:M) 시간(N) 예상완료(O:Q) 비고(R:AD).
      //  · 배정 대기 : A:AD 전체 병합. 헤더 행은 페이지마다 반복(printTitlesRow). 가로 A4.
      const xlmod = await import("exceljs");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ExcelJS: any = (xlmod as any).default ?? xlmod;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wb: any = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws: any = wb.addWorksheet(processLine, { views: [{ showGridLines: false }] });
      ws.columns = Array.from({ length: 30 }, (_, i) => ({ width: i < 2 ? 7.6 : 5.6 }));
      ws.pageSetup = {
        orientation: "landscape", paperSize: 9,
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2, header: 0, footer: 0 },
        horizontalCentered: true,
      };
      const NAVY = "FF002060";
      const thin = { style: "thin", color: { argb: "FF000000" } };
      const wthin = { style: "thin", color: { argb: "FFFFFFFF" } }; // 흰색 얇은선(근무체제 헤더 안쪽 구분선)
      const box = { top: thin, left: thin, bottom: thin, right: thin };
      // 병합 논리셀: r1..r2 × c1..c2 병합, 값·글꼴·정렬은 좌상단, 테두리·채움은 구성 셀 전체에 적용
      // (엑셀은 병합영역 내부선을 숨기고 바깥 테두리만 그리므로 전 셀에 box를 줘도 깔끔한 외곽선이 됨).
      // opts.borderObj로 변(邊)별 테두리를 직접 지정 가능(헤더 안쪽 흰선, 작업명 행간 제거 등).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cell = (r1: number, c1: number, r2: number, c2: number, value: string | number, opts: any = {}) => {
        if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
        for (let rr = r1; rr <= r2; rr++)
          for (let cc = c1; cc <= c2; cc++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cl: any = ws.getCell(rr, cc);
            if (opts.border !== false) cl.border = opts.borderObj ?? box;
            if (opts.fill) cl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = ws.getCell(r1, c1);
        m.value = value;
        if (opts.font) m.font = opts.font;
        m.alignment = opts.align ?? { vertical: "middle" };
        return m;
      };
      const whiteBold = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
      const ctr = { vertical: "middle", horizontal: "center", wrapText: true };

      let r = 1;
      // ── 상단: 설비별 요일 근무체제 (낙정·배접 제외) ──
      const shiftMachines = machines.filter((mm) => isShiftPanelMachine(mm.name));
      if (shiftMachines.length > 0) {
        // 제목(좌) + 출력 일시(우)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tt: any = ws.getCell(r, 1); tt.value = "설비별 요일 근무체제"; tt.font = { bold: true, size: 12 }; tt.alignment = { vertical: "middle" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts: any = ws.getCell(r, 30); ts.value = `출력 ${printStamp}`; ts.font = { size: 10 }; ts.alignment = { vertical: "middle", horizontal: "right" };
        ws.getRow(r).height = 20; r++;
        // 헤더: 설비(A:B) + 7요일(각 4열). 안쪽 구분선은 흰색, 바깥 테두리만 검정.
        cell(r, 1, r, 2, "설비", { fill: NAVY, font: whiteBold, align: ctr, borderObj: { top: thin, bottom: thin, left: thin, right: wthin } });
        EXTRA_DAYS.forEach(([, l], i) => {
          const last = i === EXTRA_DAYS.length - 1;
          cell(r, 3 + i * 4, r, 6 + i * 4, l, { fill: NAVY, font: whiteBold, align: ctr, borderObj: { top: thin, bottom: thin, left: wthin, right: last ? thin : wthin } });
        });
        ws.getRow(r).height = 20; r++;
        // 설비 행: 이름 + 요일별 근무체제
        for (const m of shiftMachines) {
          const ex = parseExtraNotes(machineExtras[m.id] ?? m.extra_notes ?? "");
          cell(r, 1, r, 2, m.name, { font: { bold: true, size: 10 }, align: ctr });
          EXTRA_DAYS.forEach(([k], i) => cell(r, 3 + i * 4, r, 6 + i * 4, (ex[k] || "").replace(/\n/g, " "), { font: { size: 10 }, align: ctr }));
          ws.getRow(r).height = 22; r++;
        }
        r++; // 빈 줄 간격
      }

      // ── 제책 작업 계획 ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tp: any = ws.getCell(r, 1); tp.value = `${processLine} 작업 계획`; tp.font = { bold: true, size: 12 }; tp.alignment = { vertical: "middle" };
      ws.getRow(r).height = 22; r++;
      const schedHdrRow = r;
      // 헤더 테두리: 안쪽 구분선 흰색, 바깥만 검정.
      const hdrBd = (first: boolean, last: boolean) => ({ top: thin, bottom: thin, left: first ? thin : wthin, right: last ? thin : wthin });
      // 헤더: 설비명(A:B) no.(C) 작업명(D:M) 시간(N) 예상완료(O:Q) 비고(R:AD)
      cell(r, 1, r, 2, "설비명", { fill: NAVY, font: whiteBold, align: ctr, borderObj: hdrBd(true, false) });
      cell(r, 3, r, 3, "no.", { fill: NAVY, font: whiteBold, align: ctr, borderObj: hdrBd(false, false) });
      cell(r, 4, r, 13, "작업명", { fill: NAVY, font: whiteBold, align: ctr, borderObj: hdrBd(false, false) });
      cell(r, 14, r, 14, "시간", { fill: NAVY, font: whiteBold, align: ctr, borderObj: hdrBd(false, false) });
      cell(r, 15, r, 17, "예상완료", { fill: NAVY, font: whiteBold, align: ctr, borderObj: hdrBd(false, false) });
      cell(r, 18, r, 30, "비고", { fill: NAVY, font: whiteBold, align: ctr, borderObj: hdrBd(false, true) });
      ws.getRow(r).height = 20; r++;
      // 설비별 블록: 배정 개수만큼 줄, 없으면 빈 줄 1개(설비명만).
      for (const { machine, rows } of jechaeMachineRows()) {
        const rr: (JmRow | null)[] = rows.length ? rows : [null];
        const start = r;
        const shiftLabel = machineShiftToday(machine).label; // 오늘 근무체제(설비명 아래 표기)
        rr.forEach((row, i) => {
          const mf = row ? markArgb(row.mark) : undefined; // 표시색(있으면 제품 행 배경 채움)
          // 데이터 열(no.·작업명·시간·예상완료·비고): 설비 블록 내부의 행간 가로선 제거
          // (첫 행만 top, 마지막 행만 bottom, 좌우는 유지 → 설비별로 하나의 상자).
          const rowBd = { left: thin, right: thin, ...(i === 0 ? { top: thin } : {}), ...(i === rr.length - 1 ? { bottom: thin } : {}) };
          cell(r, 3, r, 3, row ? i + 1 : "", { font: { size: 10 }, align: { vertical: "middle", horizontal: "center" }, fill: mf, borderObj: rowBd });
          cell(r, 4, r, 13, row ? row.job : "", { font: { size: 10 }, align: { vertical: "middle", horizontal: "left", shrinkToFit: true }, fill: mf, borderObj: rowBd });
          cell(r, 14, r, 14, row ? row.hours : "", { font: { size: 10 }, align: { vertical: "middle", horizontal: "center" }, fill: mf, borderObj: rowBd });
          cell(r, 15, r, 17, row ? row.eta : "", { font: { size: 10 }, align: { vertical: "middle", horizontal: "center" }, fill: mf, borderObj: rowBd });
          cell(r, 18, r, 30, row ? row.note : "", { font: { size: 10 }, align: { vertical: "middle", horizontal: "left", wrapText: true }, fill: mf, borderObj: rowBd });
          r++;
        });
        // 설비명 세로 병합(A:B): 이름 + 오늘 근무체제
        cell(start, 1, r - 1, 2, `${machine.name}${shiftLabel ? `\n[${shiftLabel}]` : ""}`, { font: { size: 10 }, align: { vertical: "middle", horizontal: "center", wrapText: true } });
      }
      // 배정 대기(A:AD 전체 병합, 한 줄씩).
      if (r > schedHdrRow + 1) ws.getRow(r).addPageBreak();
      r++; // 간격
      const jwaits = waitingOrders.map((o) => waitLabel(o));
      const jwaitMin = locationMinutes(waitingOrders, undefined);
      cell(r, 1, r, 30, `배정 대기   (${jwaits.length}건)   합계 ${fmtH(jwaitMin)}`, { fill: "FFE5E7EB", font: { bold: true, size: 10 }, align: { vertical: "middle", horizontal: "left" } });
      r++;
      for (const w of (jwaits.length ? jwaits : ["-"])) {
        cell(r, 1, r, 30, w, { font: { size: 10 }, align: { vertical: "middle", horizontal: "left", shrinkToFit: true } });
        r++;
      }
      // 스케줄 헤더 행만 페이지마다 반복.
      ws.pageSetup.printTitlesRow = `${schedHdrRow}:${schedHdrRow}`;

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `제책작업계획_${ymd}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    // 매엽·윤전: 스케줄 출력화면(renderFullPrint)과 동일한 레이아웃으로 변환.
    // 설비 박스 2열 그리드(설비명+시간 회색 헤더 → 번호·제품명·비고·완료시간) + 하단 1차배정/배정대기.
    // 색·테두리·병합이 필요해 xlsx(커뮤니티판) 대신 exceljs 사용.
    const xlmod = await import("exceljs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ExcelJS: any = (xlmod as any).default ?? xlmod;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wb: any = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws: any = wb.addWorksheet(processLine, { views: [{ showGridLines: false }] });
    // 좌:번호·제품명(30)·비고(17)·완료(15) / 간격 / 우:번호·제품명(30)·비고(17)·완료(15)
    ws.columns = [
      { width: 4.5 }, { width: 30 }, { width: 17 }, { width: 15 },
      { width: 2.5 },
      { width: 4.5 }, { width: 30 }, { width: 17 }, { width: 15 },
    ];
    // 세로(Portrait). 폭은 1페이지에 맞추되(fitToHeight:0) 내용이 길면(배정 대기 등) 다음 장으로 이어짐.
    // 1행(제목·출력일시)은 페이지마다 반복.
    ws.pageSetup = {
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:1",
      margins: { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2, header: 0, footer: 0 },
    };
    const GRAY = "FFE5E7EB";
    const thin = { style: "thin", color: { argb: "FF000000" } }; // 검정 테두리
    const allThin = { top: thin, left: thin, bottom: thin, right: thin };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cset = (r: number, c: number, value: string | number, opts: any = {}) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cl: any = ws.getCell(r, c);
      cl.value = value;
      if (opts.borderObj) cl.border = opts.borderObj;
      else if (opts.border !== null) cl.border = allThin;
      if (opts.fill) cl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
      if (opts.font) cl.font = opts.font;
      cl.alignment = opts.align ?? { vertical: "middle" };
      return cl;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const box = (r1: number, c1: number, r2: number, c2: number, value: string | number, opts: any = {}) => {
      ws.mergeCells(r1, c1, r2, c2);
      const bd = opts.borderObj ?? (opts.border === null ? null : allThin);
      for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cl: any = ws.getCell(rr, cc);
        if (bd) cl.border = bd;
        if (opts.fill) cl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = ws.getCell(r1, c1);
      m.value = value;
      if (opts.font) m.font = opts.font;
      m.alignment = opts.align ?? { vertical: "middle" };
      if (opts.borderObj) m.border = opts.borderObj; // 병합 범위 테두리는 마스터 셀이 정의
      return m;
    };
    // 설비 헤더 색: 원래 색(남색)으로 통일(매엽·윤전 동일).
    const ACCENT = "FF002060";
    // 상단 제목: 윤전은 라인 색 배너(전 열 채움)+흰 글씨, 매엽은 색상바 없이 일반 텍스트(요청).
    const bannerText = isRoll ? "FFFFFFFF" : undefined; // 배너 없는 매엽은 기본(검정)
    if (isRoll) for (let cc = 1; cc <= 9; cc++) ws.getCell(1, cc).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tL: any = ws.getCell(1, 1); tL.value = `${processLine} 작업 계획`; tL.font = { bold: true, size: 14, ...(bannerText ? { color: { argb: bannerText } } : {}) }; tL.alignment = { vertical: "middle" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tR: any = ws.getCell(1, 9); tR.value = `출력 ${printStamp}`; tR.font = { size: 10, ...(bannerText ? { color: { argb: bannerText } } : {}) }; tR.alignment = { vertical: "middle", horizontal: "right" };
    ws.getRow(1).height = 24;
    // 하단(1차배정/배정대기) 없이 설비 박스 2열 그리드만. 각 줄: 번호 | 제품명 | 완료시간.
    // 제품명(47)·완료(15)는 너비를 넘치면 '셀에 맞춤'(shrinkToFit)으로 자동 축소. 좌:1~3열 / 우:5~7열.
    // 설비명 헤더: 라인 색 배경·흰 글자(프린트와 동일).
    const hdrFill = ACCENT;
    const hdrFont = (size: number) => ({ bold: true, size, color: { argb: "FFFFFFFF" } });
    let r = 2;
    for (let i = 0; i < machines.length; i += 2) {
      const sides = [machines[i], machines[i + 1]];
      const meta = sides.map((m) => {
        if (!m) return null;
        const entries = getEntriesForMachine(m.id);
        const total = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
        const memo = (machineMemos[m.id] ?? m.memo ?? "").trim();
        const shift = machineShiftToday(m).label; // 오늘 근무체제
        return { m, entries, total, memo, shift };
      });
      sides.forEach((m, si) => {
        const base = si === 0 ? 1 : 6;
        const md = meta[si];
        if (!md) { box(r, base, r, base + 3, "", {}); return; }
        box(r, base, r, base + 2, `${md.m.name}${md.shift ? `  [${md.shift}]` : ""}${md.memo ? `   ${md.memo}` : ""}`,
          { fill: hdrFill, font: hdrFont(10), align: { vertical: "middle", horizontal: "left" } });
        cset(r, base + 3, fmtH(md.total), { fill: hdrFill, font: hdrFont(9), align: { vertical: "middle", horizontal: "right" } });
      });
      ws.getRow(r).height = 16;
      r++;
      const maxRows = Math.max(1, ...meta.map((x) => (x ? x.entries.length : 0)));
      for (let k = 0; k < maxRows; k++) {
        // 제품 행: 세로선(left/right)만, 제품끼리 가로선 없음. 마지막 줄에만 아래선(박스 하단).
        const rowBd = { left: thin, right: thin, ...(k === maxRows - 1 ? { bottom: thin } : {}) };
        sides.forEach((m, si) => {
          const base = si === 0 ? 1 : 6;
          const e = meta[si]?.entries[k];
          if (e) {
            const mf = markArgb(e.mark_color); // 표시색(있으면 배경 채움)
            cset(r, base, k + 1, { font: { size: 9 }, align: { vertical: "middle", horizontal: "center" }, fill: mf, borderObj: rowBd });
            cset(r, base + 1, jobLabel(e), { font: { size: 9 }, align: { vertical: "middle", horizontal: "left", shrinkToFit: true }, fill: mf, borderObj: rowBd });
            cset(r, base + 2, (e.order_notes || "").trim(), { font: { size: 9 }, align: { vertical: "middle", horizontal: "left", shrinkToFit: true }, fill: mf, borderObj: rowBd });
            cset(r, base + 3, formatEndTime(e.end_time), { font: { size: 9 }, align: { vertical: "middle", horizontal: "center", shrinkToFit: true }, fill: mf, borderObj: rowBd });
          } else {
            for (let cc = base; cc < base + 4; cc++) cset(r, cc, "", { borderObj: rowBd });
          }
        });
        r++;
      }
      r++; // 밴드 사이 간격
    }

    // 하단: 1차 배정(좌 1~3열) + 배정 대기(우 5~7열)를 나란히 배치. 페이지 브레이크 없이
    // 각 목록이 내용만큼만 늘어나는 유동 높이(고정 그리드/페이지 분리 없음).
    const r0 = r;
    const secFont = { bold: true, size: 10 };
    const itemAlignL = { vertical: "middle", horizontal: "left", shrinkToFit: true } as const;
    const itemAlignC = { vertical: "middle", horizontal: "center", shrinkToFit: true } as const;

    // 좌측: 1차 배정 (칸을 세로로 쌓음)
    let rl = r0;
    const bkTotal = buckets.reduce((s, b) => s + locationMinutes(orders.filter((o) => showsAt(o, b.id)), b.id), 0);
    box(rl, 1, rl, 3, "1차 배정", { fill: GRAY, font: secFont, align: { vertical: "middle", horizontal: "left" } });
    cset(rl, 4, fmtH(bkTotal), { fill: GRAY, font: secFont, align: { vertical: "middle", horizontal: "center" } });
    ws.getRow(rl).height = 16;
    rl++;
    for (const b of buckets) {
      const bo = orders.filter((o) => showsAt(o, b.id));
      box(rl, 1, rl, 3, b.name, { fill: GRAY, font: secFont, align: { vertical: "middle", horizontal: "left" } });
      cset(rl, 4, fmtH(locationMinutes(bo, b.id)), { fill: GRAY, font: { bold: true, size: 9 }, align: { vertical: "middle", horizontal: "center" } });
      ws.getRow(rl).height = 16;
      rl++;
      const items = bo.length ? bo : [null];
      for (let k = 0; k < items.length; k++) {
        const o = items[k];
        const bd = { left: thin, right: thin, ...(k === items.length - 1 ? { bottom: thin } : {}) };
        if (o) {
          cset(rl, 1, k + 1, { font: { size: 9 }, align: itemAlignC, borderObj: bd });
          box(rl, 2, rl, 3, waitLabel(o, b.id), { font: { size: 9 }, align: itemAlignL, borderObj: bd });
          cset(rl, 4, fmtH(locationMinutes([o], b.id)), { font: { size: 9 }, align: itemAlignC, borderObj: bd });
        } else {
          for (let cc = 1; cc <= 4; cc++) cset(rl, cc, "", { borderObj: bd });
        }
        rl++;
      }
    }

    // 우측: 배정 대기 (한 열로 나열)
    let rr = r0;
    const mwaitMin = locationMinutes(waitingOrders, undefined);
    box(rr, 6, rr, 8, `배정 대기 (${waitingOrders.length}건)`, { fill: GRAY, font: secFont, align: { vertical: "middle", horizontal: "left" } });
    cset(rr, 9, `${fmtH(mwaitMin)}(${fmtDays(mwaitMin)})`, { fill: GRAY, font: secFont, align: { vertical: "middle", horizontal: "center" } });
    ws.getRow(rr).height = 16;
    rr++;
    const wlist = waitingOrders.length ? waitingOrders : [null];
    for (let k = 0; k < wlist.length; k++) {
      const o = wlist[k];
      const bd = { left: thin, right: thin, ...(k === wlist.length - 1 ? { bottom: thin } : {}) };
      if (o) {
        cset(rr, 6, k + 1, { font: { size: 9 }, align: itemAlignC, borderObj: bd });
        box(rr, 7, rr, 8, waitLabel(o), { font: { size: 9 }, align: itemAlignL, borderObj: bd });
        cset(rr, 9, fmtH(locationMinutes([o], undefined)), { font: { size: 9 }, align: itemAlignC, borderObj: bd });
      } else {
        for (let cc = 6; cc <= 9; cc++) cset(rr, cc, "", { borderObj: bd });
      }
      rr++;
    }
    r = Math.max(rl, rr);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `스케줄_${processLine}_${ymd}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 제책 스케줄을 PPT(.pptx)로 — 출력물(요일×설비 주간 매트릭스)을 슬라이드 2장(월화수/목금토)으로 재현.
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
    const isWaiting = bucketId === undefined; // 배정 대기에서만 카드 순서 변경(위/아래 드래그) 허용
    return (
      <div
        key={order.id}
        data-oid={order.id}
        draggable={isAdmin}
        onDragStart={() => {
          if (isWaiting) setOverWaitPanel(true); // 드래그 시작 즉시 옆 열 스크롤 잠금(타이밍 지연으로 엉뚱한 열이 올라가는 것 방지)
          return hasParts ? onDragStartAll(order.id, remainingParts) : onDragStartOrder(order.id);
        }}
        onDragEnd={() => { setWaitReorderId(null); setOverWaitPanel(false); }}
        title={hasParts ? "이 카드의 구성 전체를 설비/칸으로 드래그 (칸=한 칸에 모아 1차 배정)" : (isWaiting ? "위/아래로 드래그하여 배정 대기 순서 변경" : undefined)}
        className={`p-2.5 border transition hover:shadow-sm cursor-grab active:cursor-grabbing ${
          dragOrderId === order.id && !dragPart ? "opacity-40" : ""
        } ${waitReorderId === order.id ? (waitReorderAfter ? "border-b-2 border-b-blue-500" : "border-t-2 border-t-blue-500") : "border-gray-200"} bg-white`}
        style={order.mark_color && MARK_BG[order.mark_color] ? { background: MARK_BG[order.mark_color] } : undefined}
      >
        <div>
          <div className="flex items-center justify-between">
            <p className="font-medium text-xs leading-tight min-w-0 flex-1 break-all">{order.product_name}{rollTag(order.quantity_sheets)}</p>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {isAdmin && order.mark_color && (
                <button
                  onClick={(e) => { e.stopPropagation(); clearOrderMark(order); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="text-gray-600 hover:text-gray-900 text-sm leading-none px-1 py-0.5 border border-gray-300 bg-white/70"
                  title="확인 — 표시 지우기 (분홍=신규 / 노랑=수정)"
                >
                  ✓
                </button>
              )}
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
                onClick={(e) => { e.stopPropagation(); handleDeleteCardLocation(order, bucketId); }}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={loading}
                className="text-gray-400 hover:text-red-600 text-base leading-none px-1 py-0.5"
                title={bucketId === undefined ? "이 배정 대기 구성만 삭제 (설비 배정·다른 칸은 유지)" : "이 칸 구성만 삭제 (설비 배정·대기는 유지)"}
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
              {/* 윤전: 구성 미입력 주문도 배정 대기에서 소요시간이 보이게 표기 */}
              {isRoll && order.duration_minutes ? (
                <span className="px-2 py-0.5 border text-[11px] font-medium bg-gray-100 text-gray-600 border-gray-200">
                  {Math.round((order.duration_minutes / 60) * 10) / 10}h
                </span>
              ) : null}
              {processesForParts(parts, order.part_processes, order.special_process).filter(Boolean).map((proc) => (
                <span key={proc} className={`px-1.5 py-0 text-[10px] font-medium border ${
                  PROCESS_COLORS[proc] || "bg-gray-100 text-gray-600 border-gray-200"
                }`}>
                  {proc}
                </span>
              ))}
            </div>
          )}
          {/* 윤전은 수량을 제품명 뒤(' * 수량')에 표기하므로 여기선 제책만 별도 표기 */}
          {isJechae && order.quantity_sheets ? (
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
  // 기준일(로컬 '오늘') — 날짜가 바뀌면 자동으로 그 날 기준으로 근무체제를 가져온다.
  const todayYmd = `${now.getFullYear()}-${p2x(now.getMonth() + 1)}-${p2x(now.getDate())}`;
  const todayWeekday = now.getDay(); // 0=일 ~ 6=토
  // 설비의 '오늘' 근무체제(설비관리에서 설정). 일자별 예외 > 요일별 순으로 적용.
  // 반환: {label, dim}. 미설정이면 label="", 그 날 휴무(빈 배열/'휴무')면 "휴무".
  //  '완료'(오늘 작업 완료) 선택 시 → 앞으로 나아가며 '첫 실제 근무일'의 근무체제를 대신 표기한다.
  //  (예: 금·토=완료, 일=휴무면 → 완료·휴무일을 건너뛰고 '월요일' 근무체제를 표기)
  const machineShiftToday = (m: Machine): { label: string; dim: boolean } => {
    const dateMap = parseDateShifts(m.date_shifts);
    const dayMap = parseDayShifts(m.day_shifts);
    const resolve = (ymd: string, weekday: number): string[] | null =>
      ymd in dateMap ? dateMap[ymd] : (weekday in dayMap ? dayMap[weekday] : null);
    const labelOf = (arr: string[] | null): { label: string; dim: boolean } => {
      if (arr === null) return { label: "", dim: true };
      const real = arr.filter((s) => !isShiftMarker(s));
      if (real.length === 0) return { label: "휴무", dim: true }; // 빈 배열·'휴무' 등 → 휴무
      return { label: real.join("/"), dim: false };
    };
    const today = resolve(todayYmd, todayWeekday);
    if (today && today.includes("완료")) {
      // '완료'·'미설정(정기 휴무 등)'일은 건너뛰고, 앞으로 '설정된 첫 날'을 표기한다.
      //  · 그 날이 실제 근무면 근무체제를, 명시적 '휴무'면 '휴무'를 그대로 표기(휴무는 건너뛰지 않음).
      for (let d = 1; d <= 14; d++) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
        const ymd = `${day.getFullYear()}-${p2x(day.getMonth() + 1)}-${p2x(day.getDate())}`;
        const arr = resolve(ymd, day.getDay());
        if (arr === null || arr.includes("완료")) continue; // 미설정·완료 → 건너뜀
        return labelOf(arr);                                // 설정된 첫 날: 근무체제, 또는 명시적 휴무면 '휴무'
      }
      return { label: "완료", dim: true }; // 앞으로 설정된 날이 없으면(전부 완료·미설정) '완료' 표기
    }
    return labelOf(today);
  };

  // 제책 '설비별 요일 근무체제' 패널·출력·엑셀에서 제외할 설비(요청: 낙정·배접 설비는 표기 안 함).
  const isShiftPanelMachine = (name: string) => !/낙정|배접/.test(name || "");
  const jechaeShiftMachines = machines.filter((m) => isShiftPanelMachine(m.name));

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

  // 인쇄용 작업명: "제품명(구성)소요시간" — 스케줄 출력물 기계 박스에서 사용.
  // 윤전은 설비 항목 component_part가 기준(구역 독립). 비었으면 주문 component('1대' 잔재)로 폴백하지 않는다.
  const jobLabel = (e: ScheduleEntry): string => {
    const hours = e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : "";
    if (isRoll) {
      // 윤전: '제품명(구성) * 부수 시간' (요청). 구성 없으면 '제품명 * 부수'.
      const q = Number(e.quantity_sheets) || 0;
      const comp = e.component_part || e.component || "";
      const nm = comp ? `${e.product_name}(${comp})` : e.product_name;
      const base = q > 0 ? `${nm} * ${q.toLocaleString()}부` : nm;
      return hours !== "" ? `${base} ${hours}` : base;
    }
    const comp = e.component_part || e.component || "";
    const base = comp ? `${e.product_name}(${comp})` : e.product_name;
    return hours !== "" ? `${base}${hours}` : base;
  };

  // 작업순서 출력물 첫 줄: "작업명 (공백) 소요시간" (비고는 다음 줄에 별도 렌더)
  const orderSheetLabel = (e: ScheduleEntry): string => {
    const hours = e.duration_minutes ? Math.round((e.duration_minutes / 60) * 10) / 10 : "";
    if (isRoll) {
      const q = Number(e.quantity_sheets) || 0;
      const comp = e.component_part || e.component || "";
      const nm = comp ? `${e.product_name}(${comp})` : e.product_name;
      const name = q > 0 ? `${nm} * ${q.toLocaleString()}부` : nm;
      return hours !== "" ? `${name} ${hours}` : name;
    }
    const comp = e.component_part || e.component || "";
    const name = comp ? `${e.product_name}(${comp})` : e.product_name;
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
                      <tr key={i} style={e && e.mark_color && isRoll ? { background: MARK_BG[e.mark_color] } : undefined}>
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
    const data = jechaeMachineRows();
    return (
      <div className="jml-print">
        {/* [제책] 설비별 요일 작업 계획(상단 공통 패널) — 출력물에도 표기 */}
        <table className="jml" style={{ marginBottom: "3mm" }}>
          <colgroup>
            <col style={{ width: "10%" }} />
            {EXTRA_DAYS.map(([k]) => <col key={k} style={{ width: `${90 / 7}%` }} />)}
          </colgroup>
          <thead>
            <tr className="jml-title">
              <td className="jml-title-name" colSpan={4}>설비별 요일 근무체제</td>
              <td className="jml-title-date" colSpan={4}>출력 {printStamp}</td>
            </tr>
            <tr>
              <th className="jml-mc">설비</th>
              {EXTRA_DAYS.map(([k, l]) => <th key={k}>{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.filter(({ machine }) => isShiftPanelMachine(machine.name)).map(({ machine }) => {
              const ex = parseExtraNotes(machineExtras[machine.id] ?? machine.extra_notes ?? "");
              return (
                <tr key={machine.id} className="jml-row-end">
                  <td className="jml-mc">{machine.name}</td>
                  {EXTRA_DAYS.map(([k]) => (
                    <td key={k} className="jml-note" style={{ textAlign: "center" }}>{ex[k] || ""}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="jml-sched-title">{processLine} 작업 계획</div>
        {/* 설비마다 '별도의 표'로 만든다.
            - thead(설비명 + 열 머리글)는 display:table-header-group → 표가 페이지를 넘어가면
              넘어간 장 상단에 설비명이 '자동으로 다시' 표기된다.
            - tfoot(마감선)는 display:table-footer-group → 페이지 하단마다 반복되어, 설비가
              페이지 경계에서 잘려도 그 장 아래가 '선으로 마무리'된다(열린 채 끊기지 않음).
            - 본문 행 사이에는 가로선을 두지 않아 기존의 깔끔한 모양을 유지한다. */}
        {data.map(({ machine, rows }) => {
          const rr: (JmRow | null)[] = rows.length ? rows : [null];
          const shift = machineShiftToday(machine).label; // 오늘 근무체제(설비명 아래)
          return (
            <table className="jml jml-mtbl" key={machine.id}>
              <colgroup>
                <col style={{ width: "7.4%" }} />
                <col style={{ width: "3.9%" }} />
                <col style={{ width: "35.2%" }} />
                <col style={{ width: "4.9%" }} />
                <col style={{ width: "10.9%" }} />
                <col style={{ width: "37.7%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="jml-mc">{machine.name}{shift ? <div className="jml-shift">[{shift}]</div> : null}</th>
                  <th className="jml-no">no.</th>
                  <th className="jml-job">작업명</th>
                  <th className="jml-dur">시간</th>
                  <th className="jml-eta">예상완료</th>
                  <th className="jml-note">비고</th>
                </tr>
              </thead>
              <tfoot>
                <tr className="jml-foot"><td colSpan={6} /></tr>
              </tfoot>
              <tbody>
                {rr.map((row, i) => (
                  <tr key={i} style={row && row.mark ? { background: MARK_BG[row.mark] } : undefined}>
                    <td className="jml-mc" />
                    <td className="jml-no">{row ? i + 1 : ""}</td>
                    <td className="jml-job">{row ? row.job : ""}</td>
                    <td className="jml-dur">{row ? row.hours : ""}</td>
                    <td className="jml-eta">{row ? row.eta : ""}</td>
                    <td className="jml-note">{row ? row.note : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        })}
      </div>
    );
  };

  // 스케줄 전체 개요 인쇄: 상단 기계별 작업계획 + 하단 1차 배정·배정 대기. A4 한 장에 꽉 차게.
  const renderFullPrint = () => {
    // 위치(대기=undefined / 칸=bucketId)에 실제로 남은 구성만 표기 — 화면 카드와 일치.
    const ov = (o: Order, bucketId?: number) => {
      const hasParts = parseParts(o.component).length > 0;
      const comp = hasParts ? partsAtLocation(o, bucketId).join(", ") : o.component;
      const q = isRoll && o.quantity_sheets ? ` ${o.quantity_sheets.toLocaleString()}부` : "";
      return `${o.product_name}${comp ? `(${comp})` : ""}${q}`;
    };
    // 기계 박스(46mm 고정)에 들어가는 만큼만 표시 — 배정이 많아도 출력 크기를 넘지 않게 캡.
    // (작업명이 길어 한 줄을 넘으면 폰트를 실측해 유동 축소 — 위 useEffect가 담당)
    // 윤전은 첫 제품 아래 메모 줄이 더 들어가 10개면 마지막이 잘린다 → 9개까지만 표기.
    const PF_ROWS = isRoll ? 9 : 10;
    // 설비가 많아 그리드가 길어지면 하단 1차 배정(고정 80mm)이 A4 밖으로 잘린다.
    // 설비 수에 맞춰 박스 높이를 줄여 '설비 그리드 + 하단 80mm'가 항상 한 장에 들어가게 한다.
    // (설비 8대 이하면 기존 46mm 그대로, 9대 이상부터 축소)
    // 설비 그리드 가용 높이를 172mm로 잡아(머리글·하단 80mm·여백 제외) 한 장에 여유 있게 들어가게.
    // 설비가 많으면 박스 높이를 줄여 하단 1차 배정 4칸(HDP 포함)이 항상 보이게 한다.
    const numMachineRows = Math.max(1, Math.ceil(machines.length / 2));
    const machineRowH = Math.min(46, Math.max(26, (172 - (numMachineRows - 1) * 2.5) / numMachineRows));
    // 하단 1차 배정 칸 수: 매엽은 4칸 고정(HDP 포함 항상 보이게), 윤전은 실제 칸 수만큼(2칸=동일 높이 2분할).
    const bkCount = isRoll ? Math.max(1, buckets.length) : Math.max(4, buckets.length);
    return (
      <div className={`pf-page${isRoll ? " pf-roll" : ""}`}>
        <div className="pf-head pf-head-rel"><span className="pf-line">{processLine}</span> 작업 계획<span className="pf-head-time">출력 {printStamp}</span></div>
        <div className="pf-machines" style={{ gridAutoRows: `${machineRowH}mm` }}>
          {machines.map((m) => {
            const entries = getEntriesForMachine(m.id);
            const total = entries.reduce((s, e) => s + (e.duration_minutes || 0), 0);
            const shown = entries.slice(0, PF_ROWS);
            const overflowCount = entries.length - shown.length;
            const memo = (machineMemos[m.id] ?? m.memo ?? "").trim();
            // 윤전 전용: 헤더 메모(memo)와 별개로 '맨 위 제품 아래'에 추가되는 메모(extra_notes 재사용)
            const rollMemo = isRoll ? (machineExtras[m.id] ?? m.extra_notes ?? "").trim() : "";
            const shift = machineShiftToday(m); // 오늘(기준일) 근무체제 — 출력물 설비명 옆에 표기
            return (
              <div className="pf-mbox" key={m.id}>
                <div className="pf-mname">
                  {/* 헤더 메모(설비명 우측)는 매엽·윤전 공통 유지 + 오늘 근무체제 표기 */}
                  <span className="pf-mname-l">{m.name}{shift.label ? <span className="pf-shift"> [{shift.label}]</span> : null}{overflowCount > 0 ? <span className="pf-more"> 외 {overflowCount}건</span> : null}{memo ? <span className="pf-memo-inline"> {memo}</span> : null}</span>
                  <span className="pf-mtime">{fmtH(total)}</span>
                </div>
                {entries.length === 0 ? (
                  <div className="pf-empty">{rollMemo ? <span className="pf-memo-block">{rollMemo}</span> : "-"}</div>
                ) : (
                  <ol className="pf-list">
                    {shown.map((e, i) => {
                      const lbl = jobLabel(e);
                      return (
                      <Fragment key={e.id}>
                      <li style={e.mark_color ? { background: MARK_BG[e.mark_color] } : undefined}>
                        <div className="pf-li">
                          <span className="pf-num">{i + 1}</span>
                          <span className="pf-job">{lbl}</span>
                          <span className="pf-note">{(e.order_notes || "").trim()}</span>
                          <span className="pf-eta">{formatEndTime(e.end_time)}</span>
                        </div>
                      </li>
                      {/* 윤전: 맨 위(첫 번째) 제품 아래에 추가 메모(extra_notes)를 한 줄로 출력 */}
                      {isRoll && i === 0 && rollMemo ? (
                        <li className="pf-memo-li">{rollMemo}</li>
                      ) : null}
                      </Fragment>
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
            <div className="pf-bk-grid" style={{ gridTemplateRows: `repeat(${bkCount}, 1fr)` }}>
              {Array.from({ length: bkCount }).map((_, i) => {
                const b = buckets[i];
                const bo = b ? orders.filter((o) => showsAt(o, b.id)) : [];
                return (
                  <div key={i} className="pf-bk">
                    {b && (
                      <>
                        <div className="pf-bk-ttl">{b.name}<span className="pf-bk-sum">{fmtH(locationMinutes(bo, b.id))}</span></div>
                        <div className="pf-bk-items">
                          {bo.length ? bo.map((o) => <div key={o.id} className="pf-bk-item">{ov(o, b.id)}</div>) : <span className="pf-dim">-</span>}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="pf-sect">
            <div className="pf-secttl">배정 대기 <span className="pf-secsum">{fmtH(locationMinutes(waitingOrders, undefined))} · {fmtDays(locationMinutes(waitingOrders, undefined))}</span></div>
            <div className="pf-secbody">
              {waitingOrders.map((o) => (
                <div key={o.id} className="pf-row">
                  <span className="pf-row-lbl">{ov(o)}</span>
                  <span className="pf-row-dur">{fmtH(locationMinutes([o], undefined))}</span>
                </div>
              ))}
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
    {/* 가로만 스크롤(세로는 각 열이 자체 스크롤). 세로 스크롤을 열어두면 드래그 중 자동스크롤이 이 컨테이너를
        움직여 기계별 작업계획까지 올라가 버린다. */}
    <div className="overflow-x-auto overflow-y-hidden h-[calc(100vh-80px)]">
    {/* 고정 폭(반응형 축소 없음). 화면이 작으면 비율 축소 대신 가로/세로 스크롤로 본다. */}
    <div className="flex gap-4 h-full min-w-[1776px]">
      {/* 좌측: 설비별 배정 현황 */}
      <div ref={listScrollRef} className={`flex-1 space-y-3 pr-2 ${overWaitPanel ? "overflow-y-hidden" : "overflow-y-auto"}`}>
        <div className="flex items-center justify-between mb-2 sticky top-0 bg-gray-50 py-2 z-10">
          <div className="shrink-0">
            <h2 className="text-xl font-bold text-gray-900 whitespace-nowrap">기계별 작업 계획</h2>
            <p className="text-xs text-gray-500">{dateStr}</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {isAdmin && (
              <button
                onClick={undo}
                disabled={undoCount === 0}
                className={`text-xs border px-2 py-1 whitespace-nowrap ${undoCount === 0 ? "border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed" : "border-amber-500 bg-amber-50 text-amber-700 font-medium hover:bg-amber-100"}`}
                title={undoCount === 0 ? "되돌릴 변경이 없습니다 (새로고침하면 이력이 초기화됩니다)" : `직전 변경 되돌리기 (Ctrl+Z) · ${undoCount}단계 가능`}
              >
                ↩ 되돌리기{undoCount > 0 ? ` (${undoCount})` : ""}
              </button>
            )}
            <button
              onClick={openNote}
              className={`text-xs border px-2 py-1 whitespace-nowrap ${workNote.trim() ? "border-green-400 bg-green-50 text-green-700 font-medium" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-100"}`}
              title={isAdmin ? "완료책명 메모장 (자유롭게 입력)" : "완료책명 보기 (관리자만 편집)"}
            >
              📖 완료책명
            </button>
            {/* [추가] 설비별 진행현황 요약 — 출력 없이 화면에서 한눈에 보기 */}
            <button
              onClick={() => { setSummaryFull(true); setShowSummary(true); }}
              className="text-xs border border-blue-500 bg-blue-600 px-2 py-1 hover:bg-blue-700 text-white font-medium whitespace-nowrap"
              title="설비별로 어떤 제품이 언제 끝나는지 한눈에 보는 요약 화면 (출력 불필요)"
            >
              📋 진행현황
            </button>
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
              onClick={downloadExcel}
              className="text-xs border border-gray-300 bg-white px-2 py-1 hover:bg-gray-100 text-gray-700 whitespace-nowrap"
              title="기계별 작업 계획을 엑셀(.xlsx) 파일로 내려받습니다"
            >
              📊 엑셀
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

        {/* [제책] 설비별×요일 작업계획 입력 — 화면 맨 위 공통 패널(기존 설비 하단 요일칸을 대체) */}
        {isJechae && linesReady && jechaeShiftMachines.length > 0 && (
          <div className="bg-white mb-3">
            {/* 외곽 테두리는 표(1px)로만 그린다. 제목줄은 표와 같은 굵기의 좌/우/상 테두리만(이중선 방지). */}
            <div className="px-2 py-1.5 bg-gray-800 text-white text-sm font-bold border-x border-t border-black">설비별 요일 근무체제</div>
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col style={{ width: "96px" }} />
                {EXTRA_DAYS.map(([k]) => <col key={k} />)}
              </colgroup>
              <thead>
                <tr>
                  {/* 칸 사이 구분선은 흰색, 바깥쪽(설비 좌측·일 우측)은 표 테두리와 같은 검정 */}
                  <th className="border border-white border-l-black bg-gray-800 text-white text-[12px] font-semibold py-1">설비</th>
                  {EXTRA_DAYS.map(([key, label], idx) => (
                    <th key={key} className={`border border-white bg-gray-800 text-white text-[12px] font-semibold py-1 ${idx === EXTRA_DAYS.length - 1 ? "border-r-black" : ""}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jechaeShiftMachines.map((m) => {
                  const ex = parseExtraNotes(machineExtras[m.id] ?? "");
                  const setField = (key: string, val: string) =>
                    handleMachineExtraChange(m.id, JSON.stringify({ ...ex, [key]: val }));
                  return (
                    <tr key={m.id}>
                      <td className="border border-black text-center text-[12px] font-semibold px-1 break-all">{m.name}</td>
                      {EXTRA_DAYS.map(([key]) => (
                        <td key={key} className="border border-black p-0 align-middle">
                          <textarea
                            rows={1}
                            className="block w-full border-0 px-1.5 py-0.5 text-[12px] leading-snug text-center resize-y outline-none focus:bg-blue-50/40 disabled:opacity-60"
                            value={ex[key] ?? ""}
                            onChange={(e) => setField(key, e.target.value)}
                            disabled={!isAdmin}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!linesReady && (
          <div className="text-center text-gray-400 text-sm py-16">불러오는 중…</div>
        )}
        {linesReady && machines.map((machine) => {
          const entries = getEntriesForMachine(machine.id);
          const isTarget = dropTarget === machine.id;
          const shiftToday = machineShiftToday(machine); // 오늘(기준일) 근무체제 — 설비명 옆 메모란 우측에 표기
          // 윤전: 헤더 메모(memo)와 별개로 '맨 위(첫 번째) 제품 아래'에 추가되는 메모 입력칸.
          // 별도 필드(extra_notes)를 재사용하며, 높이는 고정(기존 헤더 메모와 동일한 한 줄). 출력물에도 같은 위치에 나온다.
          const rollMemoEditor = isRoll ? (
            <input
              type="text"
              className="w-full text-xs h-6 border border-amber-300 bg-amber-50 px-2 py-0.5 focus:border-amber-500 focus:ring-1 focus:ring-amber-500 outline-none disabled:opacity-60 disabled:bg-gray-50"
              placeholder={isAdmin ? "메모 (출력물에도 표시)" : ""}
              value={machineExtras[machine.id] ?? ""}
              onChange={(e) => handleMachineExtraChange(machine.id, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => e.preventDefault()}
              draggable={false}
              disabled={!isAdmin}
            />
          ) : null;

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
                  className="flex-1 min-w-0 mr-2 bg-gray-700 text-white text-xs px-2 py-0.5 border border-gray-500 focus:border-blue-400 outline-none disabled:opacity-60"
                  placeholder={isAdmin ? "메모" : ""}
                  value={machineMemos[machine.id] ?? ""}
                  onChange={(e) => handleMemoChange(machine.id, e.target.value)}
                  disabled={!isAdmin}
                />
                <div className="flex items-center gap-3 shrink-0 ml-8">
                  {/* [추가] 오늘(기준일) 근무체제 — '시작 08:30 고정' 좌측. 설비관리 요일별/일자별 설정, 날짜 바뀌면 그 날 값. */}
                  {shiftToday.label && (
                    <span
                      className={`whitespace-nowrap text-xs font-medium ${shiftToday.dim ? "text-gray-400" : "text-amber-300"}`}
                      title={`${dateStr} 근무체제: ${shiftToday.label}`}
                    >
                      🕒 {shiftToday.label}
                    </span>
                  )}
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
                isRoll ? (
                  <div className="px-3 py-3">
                    <div className="text-center text-gray-400 text-sm mb-2">우측에서 작업을 드래그하여 배정하세요</div>
                    {rollMemoEditor}
                  </div>
                ) : (
                  <div className="px-4 py-6 text-center text-gray-400 text-sm">
                    우측에서 작업을 드래그하여 배정하세요
                  </div>
                )
              ) : (
                <div className="px-3 pb-2">
                <table className="w-full table-fixed">
                  <thead>
                    <tr className={`text-gray-500 border-b border-gray-200 h-7 ${isJechae ? "text-[13px]" : "text-[10px]"}`}>
                      <th className="px-1.5 py-0 text-left w-6">#</th>
                      <th className="px-1.5 py-0 text-center">작업명</th>
                      <th className={`px-1.5 py-0 text-center ${isJechae ? "" : "w-44"}`}>비고</th>
                      <th className="px-1.5 py-0 text-center w-28">소요(시간)</th>
                      <th className={`px-1.5 py-0 whitespace-nowrap ${isJechae ? "text-center w-40" : "text-center w-32"}`}>예상완료</th>
                      <th className="px-1.5 py-0 text-center w-12"></th>
                      <th className="px-1.5 py-0 text-center w-16">{isAdmin ? "삭제" : ""}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const isReorderHover = reorderTarget === entry.id;
                      const isMergeHover = mergeHoverId === entry.id;
                      // 제책: 주문의 구성별 부수(part_quantities). 구성 칩 옆에 각 부수를 표기하는 데 사용.
                      const entryPartQty = parsePartDurations(allOrders.find((o) => o.id === entry.order_id)?.part_quantities);
                      const entryPartsList = parseParts(entry.component_part);
                      const hasPerPartQty = isJechae && entryPartsList.some((p) => entryPartQty[p]);
                      return (
                        <Fragment key={entry.id}>
                        <tr
                          draggable={isAdmin}
                          onDragStart={(e) => {
                            // 수정/복사/삭제 버튼 영역에서 시작한 드래그는 취소 → 버튼 누르다 실수로
                            // 순서변경·1차배정 이동되는 것을 방지.
                            if ((e.target as HTMLElement).closest(".no-drag")) { e.preventDefault(); return; }
                            setDragEntryId(entry.id);
                            setDragOrderId(null);
                            setDragPart("");
                            setDragSplit(null);
                          }}
                          onDragEnd={() => { setDragEntryId(null); setReorderTarget(null); setMergeHoverId(null); }}
                          style={isMergeHover ? undefined : { background: MARK_BG[entry.mark_color || ""] || undefined }}
                          className={`border-t border-gray-200 cursor-grab active:cursor-grabbing h-8 hover:bg-gray-50 ${dragEntryId === entry.id ? "opacity-40" : ""} ${
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
                            title={isAdmin ? "클릭: 표시색(분홍) 켜기/끄기 — 모든 관리자 공유" : ""}
                            draggable={false}
                            onClick={(e) => { e.stopPropagation(); cycleMark(entry); }}
                          >
                            {idx + 1}
                          </td>
                          <td className="px-1.5 py-0">
                            <div className="flex items-center gap-1 overflow-x-auto jobscroll">
                            <span className={`font-medium shrink-0 ${isJechae ? "text-[13px] text-black" : "text-[12px]"}`}>{isRoll ? (() => { const comp = entry.component_part || entry.component || ""; return `${entry.product_name}${comp ? `(${comp})` : ""}`; })() : entry.product_name}{rollTag(entry.quantity_sheets)}</span>
                            {(() => {
                              // 윤전은 제품명 * 수량만 표기(요청) — 구성 칩/구분 칩을 표시하지 않는다.
                              if (isRoll) return null;
                              const eparts = parseParts(entry.component_part);
                              if (eparts.length === 0) {
                                // 구성이 단일(통째 배정)이거나 구성 미입력: 구분(있으면)·구성(있으면)을 칩으로 표시
                                return (
                                  <span className="inline-flex items-center gap-0.5 shrink-0">
                                    {entry.special_process ? (
                                      <span className={`px-2 py-0.5 text-[11px] font-medium border whitespace-nowrap ${PROCESS_COLORS[entry.special_process] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
                                        {entry.special_process}
                                      </span>
                                    ) : null}
                                    {/* 윤전은 설비 항목의 component_part가 기준(구역 독립). 비었으면 주문 component('1대' 등 잔재)를 표시하지 않는다. */}
                                    {!isRoll && entry.component ? (
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
                                        className={`px-2 py-0.5 border border-gray-300 bg-gray-100 text-gray-700 ${isJechae ? "text-[13px]" : "text-[11px]"} cursor-grab active:cursor-grabbing hover:bg-blue-100 hover:border-blue-300`}
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
                                        <span className={`px-2 py-0.5 text-[11px] font-medium border whitespace-nowrap ${PROCESS_COLORS[g.proc] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
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
                                            className={`px-2 py-0.5 border ${isJechae ? "text-[13px]" : "text-[11px]"} cursor-grab active:cursor-grabbing ${
                                              isTarget
                                                ? `bg-blue-50 text-blue-700 border-blue-500 ${partReorderTarget?.after ? "border-r-4" : "border-l-4"}`
                                                : "border-gray-300 bg-gray-100 text-gray-700 hover:bg-blue-100 hover:border-blue-300"
                                            }`}
                                            title="다른 설비로 드래그하면 분리, 같은 행에서 칩의 왼쪽/오른쪽으로 드롭하면 앞/뒤로 이동"
                                          >
                                            {p}{entryPartQty[p] ? <span className="ml-1 font-normal text-gray-500">{entryPartQty[p].toLocaleString()}부</span> : null}
                                          </span>
                                        );
                                      })}
                                    </span>
                                  ))}
                                </span>
                              );
                            })()}
                            {/* 윤전은 수량을 제품명 뒤(' * 수량')에 표기. 제책은 여기서 별도 표기하되,
                                구성별 부수가 칩에 이미 표시되는 경우(다구성)엔 총합 중복 표기를 생략. */}
                            {isJechae && entry.quantity_sheets && !hasPerPartQty ? (
                              <span className={`font-medium text-gray-600 shrink-0 whitespace-nowrap text-[13px]`}>{entry.quantity_sheets.toLocaleString()}부</span>
                            ) : null}
                            </div>
                          </td>
                          <td className={`px-1.5 py-0 ${isJechae ? "text-[13px] text-black" : "text-[11px] text-gray-500"}`} title={entry.order_notes}>
                            <div className="overflow-x-auto whitespace-nowrap jobscroll text-center">{entry.order_notes}</div>
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
                                  className={`px-2 py-0.5 text-[11px] font-medium border whitespace-nowrap ${
                                    entry.print_mode === "single"
                                      ? "bg-amber-100 text-amber-700 border-amber-300"
                                      : "bg-green-100 text-green-700 border-green-300"
                                  }`}
                                >
                                  {entry.print_mode === "single" ? "단면" : "양면"}
                                </button>
                              ) : (
                                <span className="px-2 py-0.5 text-[11px] font-medium border border-gray-300 bg-gray-100 text-gray-500 whitespace-nowrap">{entry.print_mode === "single" ? "단면" : "양면"}</span>
                              )}
                            </div>
                          </td>
                          <td className={`px-1.5 py-0 font-mono text-gray-700 ${isJechae ? "text-[13px] text-center whitespace-nowrap" : "text-center"}`}>
                            {isJechae
                              ? formatEndTime(entry.end_time)
                              : <FitEndTime text={formatEndTime(entry.end_time)} />}
                          </td>
                          <td className="px-1.5 py-0 text-center">
                            <div className="flex items-center justify-center gap-1 no-drag">
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
                              </>) : <span className="text-gray-300">–</span>}
                            </div>
                          </td>
                          {/* 삭제 전용 영역: 행 오른쪽 끝, 셀 전체가 큰 클릭 버튼 (누르다 드래그 방지 = no-drag) */}
                          <td className="p-0 no-drag border-l border-gray-200">
                            {isAdmin && (
                              <button
                                onClick={() => handleDeleteEntry(entry)}
                                onMouseDown={(e) => e.stopPropagation()}
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
                                className={`w-full h-full min-h-[32px] flex items-center justify-center text-2xl leading-none transition-colors ${trashOverEntry === entry.id ? "text-red-600 bg-red-200" : "text-gray-400 hover:text-red-600 hover:bg-red-50"}`}
                                title="이 설비 배정만 삭제 (1차 배정·대기는 유지) / 구성 칩을 끌어다 놓으면 그 구성만 완료·삭제"
                              >
                                🗑
                              </button>
                            )}
                          </td>
                        </tr>
                        {/* 윤전: 맨 위(첫 번째) 제품 바로 아래에 추가 메모 입력칸 (헤더 메모와 별개, 고정 높이, 출력물에도 동일 표기) */}
                        {isRoll && idx === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-1.5 py-1">
                              {rollMemoEditor}
                            </td>
                          </tr>
                        ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
              {/* (제책 설비 하단 요일칸은 상단 공통 패널로 이동됨) */}
            </div>
          );
        })}
      </div>

      {/* 가운데: 1차 배정 (국/4×6/MB6/HDP 등 칸) — 제책 라인은 사용하지 않음 */}
      <div className={`w-[432px] bg-white shadow-sm flex flex-col overflow-hidden shrink-0 ${isJechae ? "hidden" : ""}`}>
        {/* 스크롤은 바깥에서 받고(스크롤바가 표 우측 테두리 바깥에 위치) 검정 테두리 표는 안쪽에 둔다 → 스크롤 생겨도 우측 라인 안 잘림 */}
        <div className={`flex-1 ${overWaitPanel ? "overflow-y-hidden" : "overflow-y-auto"}`}>
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
          {!linesReady ? (
            <div className="text-center text-gray-400 text-sm py-8">불러오는 중…</div>
          ) : buckets.length === 0 ? (
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
        className={`w-[432px] bg-white border shadow-sm flex flex-col overflow-hidden shrink-0 ${
          waitingDrop ? "ring-2 ring-red-400 bg-red-50/30" : ""
        }`}
        onDragOver={(e) => {
          // 배정 대기 카드끼리 순서만 바꾸는 드래그면 패널(배정 취소) 하이라이트/처리를 하지 않는다.
          const reorderingWaitCard = dragOrderId !== null && !dragPart && dragEntryId === null && dragSplit === null && waitingOrders.some((o) => o.id === dragOrderId);
          if (reorderingWaitCard) {
            // 패널 어디(헤더·빈 공간 포함)에 있어도 옆 열 스크롤 잠금 유지 → 자동스크롤이 기계별 작업계획을 못 건드림
            if (!overWaitPanel) setOverWaitPanel(true);
            return;
          }
          if (dragSplit !== null || dragEntryId !== null || dragOrderId !== null) {
            e.preventDefault();
            if (!waitingDrop) setWaitingDrop(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setWaitingDrop(false);
        }}
        onDrop={() => {
          const reorderingWaitCard = dragOrderId !== null && !dragPart && dragEntryId === null && dragSplit === null && waitingOrders.some((o) => o.id === dragOrderId);
          setWaitingDrop(false);
          if (reorderingWaitCard) { clearDragState(); return; } // 순서 변경 드롭은 카드가 처리
          onDropOnWaiting();
        }}
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
                  onChange={(e) => {
                    // 구성 추가 시, 새로 들어온 구성은 '최상단 구성의 시간'을 그대로 적용(기존 구성 시간은 유지).
                    const comp = e.target.value;
                    const np = parseParts(comp);
                    const first = np[0];
                    const topHour = (first != null && newOrder.partHours[first] != null)
                      ? newOrder.partHours[first]
                      : (newOrder.duration_hours || 0);
                    const ph = { ...newOrder.partHours };
                    for (const p of np) { if (!(p in ph)) ph[p] = topHour; }
                    setNewOrder({ ...newOrder, component: comp, partHours: ph });
                  }}
                />
                {/* 윤전·제책: 구분 대신 수량(윤전=수량(부), 제책=부수) 수기 입력. 매엽: 구분 입력. */}
                {usesQuantity ? (
                  isJechae ? (
                    <>
                      {/* 제책은 생산성 입력란 없음(소요시간 수동 입력). 단일 구성 부수는 소요시간 옆(윤전과 동일),
                          다구성이면 아래 구성표에서 구성별로 입력. */}
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
                          {/* 매엽=구성·소요·구분 / 제책=구성·소요·부수(구성별) / 윤전=구성·소요 */}
                          <div className={`grid ${(!usesQuantity || jechaeMulti) ? "grid-cols-3" : "grid-cols-2"} gap-1 mb-1`}>
                            <span className="text-[10px] text-gray-500">구성</span>
                            <span className="text-[10px] text-gray-500">소요(시간)</span>
                            {!usesQuantity && <span className="text-[10px] text-gray-500">구분</span>}
                            {jechaeMulti && <span className="text-[10px] text-gray-500">부수</span>}
                          </div>
                          <div className="space-y-1">
                            {newParts.map((p, pi) => (
                              <div key={p} className={`grid ${(!usesQuantity || jechaeMulti) ? "grid-cols-3" : "grid-cols-2"} gap-1 items-center`}>
                                <span className="text-[11px] text-gray-700 truncate" title={p}>{p}</span>
                                <input
                                  type="number" min="0" step="0.5" placeholder={pi === 0 ? "시간(전체 자동)" : "시간"}
                                  title={pi === 0 ? "최상단에 입력하면 아래 구성도 같은 값으로 자동 입력됩니다(개별 수정 가능)" : undefined}
                                  className="border px-2 py-1 text-xs w-full min-w-0"
                                  value={newOrder.partHours[p] || ""}
                                  onChange={(e) => {
                                    const v = Number(e.target.value);
                                    // 최상단(첫 구성) 입력 시 아래 구성들도 같은 값으로 자동 채움. 이후 각 칸 개별 수정 가능.
                                    if (pi === 0) {
                                      const filled = { ...newOrder.partHours };
                                      for (const q of newParts) filled[q] = v;
                                      setNewOrder({ ...newOrder, partHours: filled });
                                    } else {
                                      setNewOrder({ ...newOrder, partHours: { ...newOrder.partHours, [p]: v } });
                                    }
                                  }}
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
                                {/* 제책: 구성별 부수 입력 */}
                                {jechaeMulti && (
                                  <input
                                    type="number" min="0" step="1" placeholder="부"
                                    className="border px-2 py-1 text-xs w-full min-w-0"
                                    value={newOrder.partQuantities[p] || ""}
                                    onChange={(e) => setNewOrder({ ...newOrder, partQuantities: { ...newOrder.partQuantities, [p]: Number(e.target.value) } })}
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* 제책 단일 구성: 부수를 왼쪽(소요시간 앞)에 배치 */}
                          {isJechae && (
                            <div>
                              <label className="text-[10px] text-gray-500">부수</label>
                              <input
                                type="number" min="0" step="1" placeholder="부"
                                className="border px-2 py-1.5 text-xs w-full"
                                value={newOrder.quantity_sheets || ""}
                                onChange={(e) => setNewOrder({ ...newOrder, quantity_sheets: Number(e.target.value) })}
                              />
                            </div>
                          )}
                          <div>
                            <label className="text-[10px] text-gray-500">소요시간 (시간)</label>
                            <input
                              type="number" min="0" step="0.5" placeholder="자동"
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
                {isJechae ? (
                  <textarea
                    placeholder="비고 (Enter로 줄바꿈 — 출력물에 그대로 여러 줄로 나옵니다)"
                    className="border px-2 py-1.5 text-xs w-full col-span-2 resize-y"
                    rows={2}
                    value={newOrder.notes}
                    onChange={(e) => setNewOrder({ ...newOrder, notes: e.target.value })}
                  />
                ) : (
                  <input
                    type="text" placeholder="비고"
                    className="border px-2 py-1.5 text-xs w-full col-span-2"
                    value={newOrder.notes}
                    onChange={(e) => setNewOrder({ ...newOrder, notes: e.target.value })}
                  />
                )}
              </div>
              <button type="submit" className="w-full py-1.5 bg-blue-600 text-white text-xs font-medium">
                {editingOrderId !== null ? "수정 저장" : "등록"}
              </button>
            </form>
          </div>
        )}

        <div ref={waitListRef} className="flex-1 overflow-y-auto p-2 space-y-1">
          {!linesReady ? (
            <div className="text-center text-gray-400 text-sm py-8">불러오는 중…</div>
          ) : waitingOrders.length === 0 ? (
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
                  <div className="space-y-1 mt-1" {...waitReorderDnd}>
                    {group.map((o) => renderOrderCard(o, undefined))}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="space-y-1 min-h-full" {...waitReorderDnd}>
              {waitingOrders.map((o) => renderOrderCard(o, undefined))}
            </div>
          )}
        </div>
      </div>
    </div>

    {/* [추가] 설비별 진행현황 요약(미리보기) — 읽기 전용. 기존 데이터(machines/schedule)만 사용하며 아무것도 변경하지 않는다. */}
    {showSummary && (
      <div className={`fixed inset-0 bg-black/50 z-50 flex items-center justify-center ${summaryFull ? "p-0" : "p-3"}`} onClick={() => setShowSummary(false)}>
        <div className={`bg-white shadow-2xl flex flex-col ${summaryFull ? "w-screen h-screen" : "w-[96vw] max-w-[1600px] h-[92vh]"}`} onClick={(e) => e.stopPropagation()}>
          <div className="px-5 py-3 bg-[#002060] text-white flex items-center justify-between shrink-0">
            <div>
              <h3 className="font-bold text-lg">📋 설비별 진행현황 <span className="font-normal text-white/80 text-sm">— {processLine}</span></h3>
              <p className="text-xs text-white/70">각 설비의 작업이 언제 끝나는지 한눈에 · {printStamp} 기준 (보기 전용)</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => setSummaryFull((v) => !v)} className="text-white/80 hover:text-white text-lg leading-none px-2 py-1 border border-white/30 hover:bg-white/10" title={summaryFull ? "창 모드로" : "전체화면(최대화)"}>
                {summaryFull ? "🗗 창모드" : "⛶ 전체화면"}
              </button>
              <button onClick={() => setShowSummary(false)} className="text-white/80 hover:text-white text-2xl leading-none px-2" title="닫기">✕</button>
            </div>
          </div>
          <div ref={summaryRef} className="flex-1 overflow-y-auto p-3 bg-gray-100">
            {machines.length === 0 ? (
              <div className="text-center text-gray-400 text-sm py-10">설비가 없습니다.</div>
            ) : (
              <div className={`grid gap-3 items-start ${summaryFull ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"}`}>
                {machines.map((m) => {
                  const es = getEntriesForMachine(m.id);
                  const totalMin = es.reduce((s, e) => s + (e.duration_minutes || 0), 0);
                  const lastEnd = es.length ? formatEndTime(es[es.length - 1].end_time) : "";
                  return (
                    <div key={m.id} className="bg-white border border-gray-300 shadow-sm overflow-hidden">
                      <div className="px-2.5 py-1.5 bg-[#002060] text-white flex items-center justify-between">
                        <span className="font-bold text-sm break-all">{m.name}</span>
                        <span className="text-[11px] text-white/80 shrink-0 ml-2 whitespace-nowrap">{fmtH(totalMin)}</span>
                      </div>
                      {es.length === 0 ? (
                        <div className="px-2.5 py-3 text-center text-gray-400 text-xs">배정 없음</div>
                      ) : (
                        <>
                          <div className="px-2.5 py-1 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 flex items-center justify-between">
                            <span className="font-medium">✅ 최종 완료 예정</span>
                            <span className="font-bold font-mono">{lastEnd}</span>
                          </div>
                          <table className="w-full table-fixed text-[12px] border-collapse">
                            <colgroup>
                              <col style={{ width: "24px" }} />
                              <col />
                              <col style={{ width: "115px" }} />
                            </colgroup>
                            <thead>
                              <tr className="text-gray-400 bg-gray-50 border-b border-gray-200">
                                <th className="py-0.5 pr-1 text-right font-medium">#</th>
                                <th className="py-0.5 px-1 text-center font-medium">제품명 / 비고</th>
                                <th className="py-0.5 px-1 text-center font-medium whitespace-nowrap">완료 예정</th>
                              </tr>
                            </thead>
                            <tbody>
                              {es.map((e, i) => {
                                const note = (e.order_notes || "").trim();
                                return (
                                  <tr key={e.id} className="border-b border-gray-100 align-top" style={e.mark_color ? { background: MARK_BG[e.mark_color] } : undefined}>
                                    <td className="py-1 pr-1 text-right text-gray-400 tabular-nums">{i + 1}</td>
                                    <td className="py-1 px-1">
                                      <div className="text-gray-800 sm-fit whitespace-nowrap overflow-hidden">{e.product_name}{e.component_part ? <span className="text-gray-500"> ({e.component_part})</span> : null}</div>
                                      {note ? <div className="text-gray-500 text-[11px] mt-0.5 sm-fit whitespace-nowrap overflow-hidden">{note}</div> : null}
                                    </td>
                                    <td className="py-1 pr-7 pl-1 text-right font-mono text-[11px] tracking-[-1.05px] text-gray-700 whitespace-nowrap">{formatEndTime(e.end_time)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* [추가] 1차 배정 (판) — 어떤 판에 어떤 물량이 대기 중인지 한눈에 */}
            {buckets.length > 0 && (
              <div className="mt-5">
                <div className="text-sm font-bold text-gray-700 mb-2 px-0.5 flex items-center gap-2">
                  <span>🗂 1차 배정 (판)</span>
                  <span className="text-[11px] font-normal text-gray-400">합계 {fmtH(buckets.reduce((s, b) => s + locationMinutes(orders.filter((o) => showsAt(o, b.id)), b.id), 0))}</span>
                </div>
                <div className={`grid gap-3 items-start ${summaryFull ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"}`}>
                  {buckets.map((b) => {
                    const bo = orders.filter((o) => showsAt(o, b.id));
                    return (
                      <div key={b.id} className="bg-white border border-gray-300 shadow-sm overflow-hidden">
                        <div className="px-2.5 py-1.5 bg-teal-700 text-white flex items-center justify-between">
                          <span className="font-bold text-sm break-all">{b.name}</span>
                          <span className="text-[11px] text-white/80 shrink-0 ml-2 whitespace-nowrap">{bo.length}건 · {fmtH(locationMinutes(bo, b.id))}</span>
                        </div>
                        {bo.length === 0 ? (
                          <div className="px-2.5 py-3 text-center text-gray-400 text-xs">대기 없음</div>
                        ) : (
                          <div className="divide-y divide-gray-100">
                            {bo.map((o, i) => (
                              <div key={o.id} className="flex items-baseline gap-1.5 px-2.5 py-1">
                                <span className="text-gray-400 tabular-nums text-[11px] shrink-0 w-4 text-right">{i + 1}</span>
                                <span className="text-gray-800 text-[12px] sm-fit whitespace-nowrap overflow-hidden flex-1 min-w-0">{waitLabel(o, b.id)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* [추가] 배정 대기 — 아직 어느 판에도 안 들어간 물량 */}
            <div className="mt-5">
              <div className="text-sm font-bold text-gray-700 mb-2 px-0.5 flex items-center gap-2">
                <span>⏳ 배정 대기</span>
                <span className="text-[11px] font-normal text-gray-400">{waitingOrders.length}건 · 합계 {fmtH(locationMinutes(waitingOrders, undefined))}</span>
              </div>
              <div className="bg-white border border-gray-300 shadow-sm overflow-hidden">
                {waitingOrders.length === 0 ? (
                  <div className="px-2.5 py-3 text-center text-gray-400 text-xs">배정 대기 없음</div>
                ) : (
                  <div className={`grid ${summaryFull ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"}`}>
                    {waitingOrders.map((o, i) => (
                      <div key={o.id} className="flex items-baseline gap-1.5 px-2.5 py-1 border-b border-r border-gray-100">
                        <span className="text-gray-400 tabular-nums text-[11px] shrink-0 w-5 text-right">{i + 1}</span>
                        <span className="text-gray-800 text-[12px] sm-fit whitespace-nowrap overflow-hidden flex-1 min-w-0">{waitLabel(o)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )}

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

    {/* 완료책명 메모장 — 관리자는 자유 편집, 그 외는 확인만(읽기 전용) */}
    {showNote && (
      <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowNote(false)}>
        <div className="bg-white shadow-xl w-[560px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="px-4 py-3 border-b flex items-center justify-between bg-gray-50">
            <h3 className="font-bold text-gray-900">📖 완료책명 <span className="text-xs font-normal text-gray-400">— {processLine}</span></h3>
            <button onClick={() => setShowNote(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
          </div>
          <div className="p-3">
            <textarea
              autoFocus={isAdmin}
              readOnly={!isAdmin}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder={isAdmin ? "완료책명을 자유롭게 입력하세요 (메모장)" : "입력된 내용이 없습니다"}
              className={`w-full border px-2 py-2 text-sm h-72 resize-none ${isAdmin ? "" : "bg-gray-50 text-gray-700"}`}
            />
            {!isAdmin && <p className="text-[11px] text-gray-400 mt-1">보기 전용입니다. 편집은 관리자 모드에서 가능합니다.</p>}
          </div>
          <div className="px-4 py-3 border-t flex justify-end gap-2 bg-gray-50">
            <button onClick={() => setShowNote(false)} className="px-3 py-1.5 text-sm border bg-white hover:bg-gray-100">닫기</button>
            {isAdmin && <button onClick={saveNote} className="px-3 py-1.5 text-sm bg-blue-600 text-white hover:bg-blue-700">저장</button>}
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
