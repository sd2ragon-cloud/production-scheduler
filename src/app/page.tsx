"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
  status: string;
  duration_minutes: number;
  part_durations: string;
  part_processes: string;
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
  sequence: number;
  duration_minutes: number;
  start_time: string;
  end_time: string;
}

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

const PROCESS_COLORS: Record<string, string> = {
  "일반": "bg-blue-100 text-blue-800 border-blue-200",
  "항바니쉬": "bg-purple-100 text-purple-800 border-purple-200",
  "UV": "bg-amber-100 text-amber-800 border-amber-200",
  "IR코팅": "bg-green-100 text-green-800 border-green-200",
  "양면": "bg-cyan-100 text-cyan-800 border-cyan-200",
  "패키지": "bg-orange-100 text-orange-800 border-orange-200",
};

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

function formatEndTime(endTimeStr: string): string {
  const dt = new Date(endTimeStr);
  if (isNaN(dt.getTime())) return "-";
  const day = DAY_NAMES[dt.getDay()];
  const h = String(dt.getHours()).padStart(2, "0");
  const m = String(dt.getMinutes()).padStart(2, "0");
  return `${day} ${h}:${m}`;
}

function isOverDeadline(endTime: string, deadline: string): boolean {
  const end = new Date(endTime);
  const dl = new Date(deadline);
  if (isNaN(end.getTime()) || isNaN(dl.getTime())) return false;
  return end > dl;
}

function daysUntilDeadline(deadline: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dl = new Date(deadline);
  dl.setHours(0, 0, 0, 0);
  return Math.ceil((dl.getTime() - now.getTime()) / 86400000);
}

function deadlineColor(deadline: string): string {
  const days = daysUntilDeadline(deadline);
  if (days < 0) return "text-red-600 font-bold";
  if (days <= 2) return "text-orange-600 font-semibold";
  if (days <= 5) return "text-yellow-600";
  return "text-gray-500";
}

// 숫자 입력(예: 20260608)을 자동으로 YYYY-MM-DD 형태로 포맷
function formatDeadlineInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  const parts = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean);
  return parts.join("-");
}

export default function ScheduleBoard() {
  const { processLine } = useProcess();
  const { role } = useAuth();
  // 담당 라인만 편집 가능. 현재 보고 있는 공정 라인을 편집할 권한이 없으면 보기 전용(편집 UI 숨김).
  const isAdmin = roleCanEditLine(role, processLine);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [breaks, setBreaks] = useState<Break[]>([]);
  const [showBreaks, setShowBreaks] = useState(false);
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
  const [newOrder, setNewOrder] = useState({
    order_code: "", product_name: "", component: "", quantity_sheets: 0,
    deadline: "", special_process: "일반", priority: 5, notes: "", duration_hours: 0,
    partHours: {} as Record<string, number>,
    partProcesses: {} as Record<string, string>,
  });
  const dragOverMachine = useRef<number | null>(null);
  const [machineStartTimes, setMachineStartTimes] = useState<Record<number, string>>({});
  const [machineMemos, setMachineMemos] = useState<Record<number, string>>({});

  const fetchAll = useCallback(async () => {
    const qs = `?process_line=${encodeURIComponent(processLine)}`;
    // 식사시간(breaks)은 전 공정 공통이라 process_line 필터 없이 받는다.
    const [machRes, orderRes, schedRes, bucketRes, breakRes] = await Promise.all([
      fetch(`/api/machines${qs}`), fetch(`/api/orders${qs}`), fetch(`/api/schedule${qs}`), fetch(`/api/buckets${qs}`), fetch(`/api/breaks`),
    ]);
    const machData = await machRes.json();
    const orderData = await orderRes.json();
    const schedData = await schedRes.json();
    const bucketData = await bucketRes.json();
    const breakData = await breakRes.json();
    setBreaks(Array.isArray(breakData) ? breakData : []);
    const activeMachines = machData.filter((m: Machine) => m.is_active);
    setMachines(activeMachines);
    setOrders(orderData.filter((o: Order) => o.status === "pending"));
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
  }, [processLine]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const startTimeTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const handleStartTimeChange = (machineId: number, value: string) => {
    setMachineStartTimes((prev) => ({ ...prev, [machineId]: value }));
    const existing = startTimeTimers.current.get(machineId);
    if (existing) clearTimeout(existing);
    startTimeTimers.current.set(
      machineId,
      setTimeout(async () => {
        await fetch("/api/schedule/recalc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ machine_id: machineId, start_time: value }),
        });
        await fetchAll();
        startTimeTimers.current.delete(machineId);
      }, 600)
    );
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
    const seqMap = new Map(entryIds.map((id, i) => [id, i + 1] as const));
    setSchedule((prev) => prev.map((e) => (seqMap.has(e.id) ? { ...e, sequence: seqMap.get(e.id)! } : e)));
    await fetch("/api/schedule/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: machineId, entry_ids: entryIds }),
    });
    await fetchAll();
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
      deadline: "", special_process: "일반", priority: 5, notes: "", duration_hours: 0,
      partHours: {},
      partProcesses: {},
    });
    setShowAddForm(false);
    setEditingOrderId(null);
  };

  // 대기 주문 편집 시작: 폼을 해당 주문 값으로 채운다
  const startEditOrder = (order: Order) => {
    const parts = parseParts(order.component);
    const pd = parsePartDurations(order.part_durations);
    const pp = parsePartProcesses(order.part_processes);
    const partHours: Record<string, number> = {};
    const partProcesses: Record<string, string> = {};
    for (const p of parts) {
      partHours[p] = Math.round(((Number(pd[p]) || 0) / 60));
      partProcesses[p] = pp[p] || order.special_process || "일반";
    }
    setNewOrder({
      order_code: order.order_code || "",
      product_name: order.product_name,
      component: order.component || "",
      quantity_sheets: order.quantity_sheets || 0,
      deadline: order.deadline || "",
      special_process: order.special_process ?? "일반",
      priority: order.priority || 5,
      notes: order.notes || "",
      duration_hours: parts.length >= 2 ? 0 : Math.round((order.duration_minutes || 0) / 60),
      partHours,
      partProcesses,
    });
    setEditingOrderId(order.id);
    setShowAddForm(true);
  };

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const parts = parseParts(newOrder.component);
    let partDurations: Record<string, number> = {};
    const partProcesses: Record<string, string> = {};
    let durationMinutes = 0;
    if (parts.length >= 2) {
      // 구성이 여러 개면 파트별 소요시간/구분을 저장, 전체 소요는 합계
      for (const p of parts) {
        partDurations[p] = Math.round((newOrder.partHours[p] || 0) * 60);
        partProcesses[p] = newOrder.partProcesses[p] || newOrder.special_process || "일반";
      }
      durationMinutes = Object.values(partDurations).reduce((a, b) => a + b, 0);
    } else {
      durationMinutes = Math.round((newOrder.duration_hours || 0) * 60);
    }
    if (editingOrderId !== null) {
      await fetch(`/api/orders/${editingOrderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          duration_minutes: durationMinutes,
          part_durations: partDurations,
          part_processes: partProcesses,
          status: "pending",
        }),
      });
    } else {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newOrder,
          duration_minutes: durationMinutes,
          part_durations: partDurations,
          part_processes: partProcesses,
          process_line: processLine,
        }),
      });
    }
    resetForm();
    await fetchAll();
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
        await handleUnassign(dragEntryId);
        await handleAssign(entry.order_id, machineId, entry.component_part || "", 0, beforeEntryId);
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

  // 주문 카드 (배정 대기 / 1차 배정 칸 공용). bucketId=undefined면 대기, 숫자면 그 칸.
  // 해당 위치에 표시할 남은 구성이 없으면 렌더하지 않음.
  const renderOrderCard = (order: Order, bucketId?: number) => {
    const days = daysUntilDeadline(order.deadline);
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
        } ${
          days < 0 ? "border-red-300 bg-red-50" : days <= 2 ? "border-orange-200 bg-orange-50/50" : "border-gray-200 bg-white"
        }`}
      >
        <div>
          <div className="flex items-center justify-between">
            <p className="font-medium text-xs leading-tight min-w-0 flex-1 break-all">{order.product_name}</p>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              <p className={`text-xs font-mono ${deadlineColor(order.deadline)}`}>
                {order.deadline}
              </p>
              <p className={`text-xs ${days < 0 ? "text-red-600" : days <= 2 ? "text-orange-500" : "text-gray-400"}`}>
                {days < 0 ? `${Math.abs(days)}일 초과` : days === 0 ? "오늘" : `D-${days}`}
              </p>
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
                    title={`${p} · ${proc} · 이 파트를 설비로 드래그하여 배정 (남은 시간 내에서 분할 가능)`}
                  >
                    {label} <span className="opacity-70">· {proc}</span>
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
          {order.notes && (
            <p className="text-xs text-gray-500 mt-1.5 break-all" title={order.notes}>비고 : {order.notes}</p>
          )}
        </div>
      </div>
    );
  };

  const now = new Date();
  const dateStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;

  return (
    <div className="overflow-auto h-[calc(100vh-80px)]">
    {/* 고정 폭(반응형 축소 없음). 화면이 작으면 비율 축소 대신 가로/세로 스크롤로 본다. */}
    <div className="flex gap-4 h-full min-w-[1776px]">
      {/* 좌측: 설비별 배정 현황 */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-2">
        <div className="flex items-center justify-between mb-2 sticky top-0 bg-gray-50 py-2 z-10">
          <div>
            <h2 className="text-xl font-bold text-gray-900">기계별 작업 계획</h2>
            <p className="text-xs text-gray-500">{dateStr}</p>
          </div>
          {isAdmin && (
            <button
              onClick={() => setShowBreaks(true)}
              className="text-sm border border-gray-300 bg-white px-3 py-1.5 hover:bg-gray-100 text-gray-700 whitespace-nowrap"
              title="식사·휴게 시간을 추가/수정하면 예상완료시간이 자동으로 다시 계산됩니다"
            >
              🍽 식사시간 {breaks.length > 0 && <span className="text-gray-400">({breaks.length})</span>}
            </button>
          )}
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
              <div className="bg-gray-800 text-white px-4 py-2 flex items-center gap-3">
                <span className="font-bold w-16 shrink-0 whitespace-nowrap">{machine.name}</span>
                <input
                  type="text"
                  className="flex-1 min-w-0 bg-gray-700 text-white text-xs px-2 py-0.5 border border-gray-500 focus:border-blue-400 outline-none disabled:opacity-60"
                  placeholder={isAdmin ? "메모" : ""}
                  value={machineMemos[machine.id] ?? ""}
                  onChange={(e) => handleMemoChange(machine.id, e.target.value)}
                  disabled={!isAdmin}
                />
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400">시작</span>
                    <input
                      type="time"
                      className="bg-gray-700 text-white text-xs px-2 py-0.5 border border-gray-500 focus:border-blue-400 outline-none disabled:opacity-60"
                      style={{ width: "7rem", colorScheme: "dark" }}
                      value={machineStartTimes[machine.id] || "08:00"}
                      onChange={(e) => handleStartTimeChange(machine.id, e.target.value)}
                      disabled={!isAdmin}
                    />
                  </div>
                  <span className="text-sm text-gray-300 w-12 text-right shrink-0">{entries.length}건</span>
                </div>
              </div>

              {entries.length === 0 ? (
                <div className="px-4 py-6 text-center text-gray-400 text-sm">
                  우측에서 작업을 드래그하여 배정하세요
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-gray-500 text-[10px] border-b h-7">
                      <th className="px-1.5 py-0 text-left w-6">#</th>
                      <th className="px-1.5 py-0 text-left">작업명</th>
                      <th className="px-1.5 py-0 text-center w-28">비고</th>
                      <th className="px-1.5 py-0 text-center w-28">소요(시간)</th>
                      <th className="px-1.5 py-0 text-left w-20">예상완료</th>
                      <th className="px-1.5 py-0 text-left w-20">납기</th>
                      <th className="px-1.5 py-0 text-center w-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const over = isOverDeadline(entry.end_time, entry.deadline);
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
                          className={`border-t cursor-grab active:cursor-grabbing h-7 ${
                            over ? "bg-red-50" : "hover:bg-gray-50"
                          } ${dragEntryId === entry.id ? "opacity-40" : ""} ${
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
                            if (fromEntry && fromEntry.machine_id === machine.id) {
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
                          <td className="px-1.5 py-0 text-gray-400 text-[10px]">{entry.sequence}</td>
                          <td className="px-1.5 py-0 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                            <span className="font-medium text-[11px] shrink-0">{entry.product_name}</span>
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
                                        className="px-1.5 py-0 border border-gray-300 bg-gray-100 text-gray-700 text-[10px] cursor-grab active:cursor-grabbing hover:bg-blue-100 hover:border-blue-300"
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
                                      <span className={`px-1.5 py-0 text-[10px] font-medium border whitespace-nowrap ${PROCESS_COLORS[g.proc] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
                                        {g.proc}
                                      </span>
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
                                            className={`px-1.5 py-0 border text-[10px] cursor-grab active:cursor-grabbing ${
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
                            </div>
                          </td>
                          <td className="px-1.5 py-0 text-center text-[10px] text-gray-500 truncate max-w-[10rem]" title={entry.order_notes}>
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
                                title="실제 소요시간 (양면 설비는 절반 적용). 0.5시간(30분) 단위"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => handleDurationChange(entry.id, Number(e.target.value) || 0)}
                                disabled={!isAdmin}
                              />
                              {isDoubleSided(machine.name) && isAdmin ? (
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
                          <td className={`px-1.5 py-0 font-mono text-[11px] ${over ? "text-red-600 font-bold" : "text-gray-700"}`}>
                            {formatEndTime(entry.end_time)}
                          </td>
                          <td className={`px-1.5 py-0 text-[11px] ${deadlineColor(entry.deadline)}`}>
                            {entry.deadline}
                          </td>
                          <td className="px-1.5 py-0 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              {isAdmin ? (<>
                              <button
                                onClick={() => handleUnassign(entry.id)}
                                disabled={loading}
                                className="text-red-400 hover:text-red-600 text-sm px-0.5"
                                title="배정 해제 (대기로 복귀)"
                              >
                                ✕
                              </button>
                              <button
                                onClick={() => handleDeleteOrder(entry.order_id, entry.product_name)}
                                disabled={loading}
                                className="text-gray-400 hover:text-red-600 text-sm leading-none px-0.5"
                                title="주문 영구 삭제"
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
              )}
            </div>
          );
        })}
      </div>

      {/* 가운데: 1차 배정 (국/4×6/MB6/HDP 등 칸) */}
      <div className="w-[480px] bg-white border shadow-sm flex flex-col overflow-hidden shrink-0">
        <div className="px-3 py-3 border-b bg-gray-50 flex items-center justify-between">
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

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
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
                  className={`border ${isTarget ? "ring-2 ring-blue-500 border-blue-300 bg-blue-50/40" : "border-gray-200"}`}
                >
                  <div className="bg-gray-100 px-2 py-1 flex items-center justify-between border-b">
                    {manageBuckets ? (
                      <input
                        defaultValue={b.name}
                        onBlur={(e) => renameBucket(b.id, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        className="text-xs font-bold border px-1 py-0.5 w-24"
                      />
                    ) : (
                      <span className="text-xs font-bold text-gray-800">{b.name}</span>
                    )}
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-gray-400">{bucketOrders.length}건</span>
                      {manageBuckets && (
                        <>
                          <button onClick={() => moveBucket(idx, -1)} disabled={idx === 0} className="text-gray-400 hover:text-gray-700 text-[10px] disabled:opacity-30" title="위로">▲</button>
                          <button onClick={() => moveBucket(idx, 1)} disabled={idx === buckets.length - 1} className="text-gray-400 hover:text-gray-700 text-[10px] disabled:opacity-30" title="아래로">▼</button>
                          <button onClick={() => deleteBucket(b)} className="text-red-400 hover:text-red-600 text-xs" title="칸 삭제">✕</button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="p-1.5 space-y-1 min-h-[9rem]">
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
            <p className="text-xs text-gray-500">{waitingOrders.length}건</p>
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
                {/* 구성이 여러 개면 파트별 구분으로 입력하므로 상단 구분란은 숨긴다 (2중 입력 방지) */}
                {parseParts(newOrder.component).length < 2 && (
                  <div className="col-span-2">
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
                {(() => {
                  const newParts = parseParts(newOrder.component);
                  const multi = newParts.length >= 2;
                  return (
                    <>
                      <div className={multi ? "col-span-2" : ""}>
                        <label className="text-[10px] text-gray-500">납기일</label>
                        <input
                          type="text" inputMode="numeric" required placeholder="YYYYMMDD"
                          maxLength={10}
                          className="border px-2 py-1.5 text-xs w-full"
                          value={newOrder.deadline}
                          onChange={(e) => setNewOrder({ ...newOrder, deadline: formatDeadlineInput(e.target.value) })}
                        />
                      </div>
                      {multi ? (
                        <div className="col-span-2">
                          <div className="grid grid-cols-3 gap-1 mb-1">
                            <span className="text-[10px] text-gray-500">구성</span>
                            <span className="text-[10px] text-gray-500">소요(시간)</span>
                            <span className="text-[10px] text-gray-500">구분</span>
                          </div>
                          <div className="space-y-1">
                            {newParts.map((p) => (
                              <div key={p} className="grid grid-cols-3 gap-1 items-center">
                                <span className="text-[11px] text-gray-700 truncate" title={p}>{p}</span>
                                <input
                                  type="number" min="0" step="1" placeholder="시간"
                                  className="border px-2 py-1 text-xs w-full min-w-0"
                                  value={newOrder.partHours[p] || ""}
                                  onChange={(e) => setNewOrder({ ...newOrder, partHours: { ...newOrder.partHours, [p]: Number(e.target.value) } })}
                                />
                                <select
                                  className="border px-1 py-1 text-xs w-full min-w-0"
                                  value={newOrder.partProcesses[p] || newOrder.special_process}
                                  onChange={(e) => setNewOrder({ ...newOrder, partProcesses: { ...newOrder.partProcesses, [p]: e.target.value } })}
                                >
                                  {PROCESSES.map((proc) => <option key={proc} value={proc}>{proc}</option>)}
                                </select>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className="text-[10px] text-gray-500">소요시간 (시간)</label>
                          <input
                            type="number" min="0" step="1" placeholder="자동"
                            className="border px-2 py-1.5 text-xs w-full"
                            value={newOrder.duration_hours || ""}
                            onChange={(e) => setNewOrder({ ...newOrder, duration_hours: Number(e.target.value) })}
                          />
                        </div>
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
    </div>
  );
}
