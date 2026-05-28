"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useProcess } from "./components/ProcessContext";

interface Machine {
  id: number;
  name: string;
  description: string;
  speed_sheets_per_hour: number;
  setup_time_minutes: number;
  capabilities: string;
  is_active: number;
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
}

interface ScheduleEntry {
  id: number;
  order_id: number;
  machine_id: number;
  machine_name: string;
  product_name: string;
  component: string;
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

export default function ScheduleBoard() {
  const { factory, processLine } = useProcess();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
  const [dragOrderId, setDragOrderId] = useState<number | null>(null);
  const [dragEntryId, setDragEntryId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [reorderTarget, setReorderTarget] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newOrder, setNewOrder] = useState({
    order_code: "", product_name: "", component: "", quantity_sheets: 0,
    deadline: "", special_process: "일반", priority: 5, notes: "",
  });
  const dragOverMachine = useRef<number | null>(null);
  const [machineStartTimes, setMachineStartTimes] = useState<Record<number, string>>({});

  const fetchAll = useCallback(async () => {
    const qs = `?factory=${encodeURIComponent(factory)}&process_line=${encodeURIComponent(processLine)}`;
    const [machRes, orderRes, schedRes] = await Promise.all([
      fetch(`/api/machines${qs}`), fetch(`/api/orders${qs}`), fetch(`/api/schedule${qs}`),
    ]);
    const machData = await machRes.json();
    const orderData = await orderRes.json();
    const schedData = await schedRes.json();
    const activeMachines = machData.filter((m: Machine) => m.is_active);
    setMachines(activeMachines);
    setOrders(orderData.filter((o: Order) => o.status === "pending"));
    setSchedule(schedData);
    setMachineStartTimes((prev) => {
      const next = { ...prev };
      for (const m of activeMachines) {
        if (!(m.id in next)) {
          next[m.id] = String(m.work_start_hour).padStart(2, "0") + ":00";
        }
      }
      return next;
    });
  }, [factory, processLine]);

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

  const handleAssign = async (orderId: number, machineId: number) => {
    setLoading(true);
    const startTime = machineStartTimes[machineId] || "08:00";
    await fetch("/api/schedule/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId, machine_id: machineId, start_time: startTime }),
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

  const handleReorder = async (machineId: number, entryIds: number[]) => {
    setLoading(true);
    await fetch("/api/schedule/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: machineId, entry_ids: entryIds }),
    });
    await fetchAll();
    setLoading(false);
  };

  const durationTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const handleDurationChange = (entryId: number, hours: number) => {
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

  const handleAddOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newOrder, factory, process_line: processLine }),
    });
    setNewOrder({
      order_code: "", product_name: "", component: "", quantity_sheets: 0,
      deadline: "", special_process: "일반", priority: 5, notes: "",
    });
    setShowAddForm(false);
    await fetchAll();
  };

  const onDragStartOrder = (orderId: number) => {
    setDragOrderId(orderId);
    setDragEntryId(null);
  };

  const onDragStartEntry = (entryId: number) => {
    setDragEntryId(entryId);
    setDragOrderId(null);
  };

  const onDragOverMachine = (e: React.DragEvent, machineId: number) => {
    e.preventDefault();
    dragOverMachine.current = machineId;
    setDropTarget(machineId);
  };

  const onDropOnMachine = async (machineId: number) => {
    if (dragOrderId !== null) {
      await handleAssign(dragOrderId, machineId);
    } else if (dragEntryId !== null) {
      const entry = schedule.find((s) => s.id === dragEntryId);
      if (entry && entry.machine_id !== machineId) {
        await handleUnassign(dragEntryId);
        await handleAssign(entry.order_id, machineId);
      }
    }
    setDragOrderId(null);
    setDragEntryId(null);
    setDropTarget(null);
  };

  const moveEntry = async (machineId: number, entryId: number, direction: "up" | "down") => {
    const machineEntries = schedule
      .filter((s) => s.machine_id === machineId)
      .sort((a, b) => a.sequence - b.sequence);
    const idx = machineEntries.findIndex((e) => e.id === entryId);
    if (idx < 0) return;
    if (direction === "up" && idx === 0) return;
    if (direction === "down" && idx === machineEntries.length - 1) return;

    const newEntries = [...machineEntries];
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    [newEntries[idx], newEntries[swapIdx]] = [newEntries[swapIdx], newEntries[idx]];

    await handleReorder(machineId, newEntries.map((e) => e.id));
  };

  const getEntriesForMachine = (machineId: number) =>
    schedule.filter((s) => s.machine_id === machineId).sort((a, b) => a.sequence - b.sequence);

  const parseCaps = (s: string): string[] => {
    try { return JSON.parse(s); } catch { return []; }
  };

  const PROCESSES = ["일반", "항바니쉬", "UV", "IR코팅", "양면", "패키지"];

  const now = new Date();
  const dateStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;

  return (
    <div>
    <div className="flex gap-4 h-[calc(100vh-80px)]">
      {/* 좌측: 설비별 배정 현황 */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-2">
        <div className="flex items-center justify-between mb-2 sticky top-0 bg-gray-50 py-2 z-10">
          <div>
            <h2 className="text-xl font-bold text-gray-900">기계별 작업 계획</h2>
            <p className="text-xs text-gray-500">{dateStr}</p>
          </div>
        </div>

        {machines.map((machine) => {
          const entries = getEntriesForMachine(machine.id);
          const caps = parseCaps(machine.capabilities);
          const isTarget = dropTarget === machine.id;

          return (
            <div
              key={machine.id}
              className={`bg-white rounded-xl border shadow-sm transition-all ${
                isTarget ? "ring-2 ring-blue-500 border-blue-300 bg-blue-50/30" : ""
              }`}
              onDragOver={(e) => onDragOverMachine(e, machine.id)}
              onDragLeave={() => { if (dragOverMachine.current === machine.id) setDropTarget(null); }}
              onDrop={() => onDropOnMachine(machine.id)}
            >
              <div className="bg-gray-800 text-white px-4 py-2 rounded-t-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-bold">{machine.name}</span>
                  <span className="text-xs text-gray-400">{machine.description}</span>
                  <div className="flex items-center gap-1.5 ml-2">
                    <span className="text-xs text-gray-400">시작</span>
                    <input
                      type="time"
                      className="bg-gray-700 text-white text-xs rounded px-2 py-0.5 border border-gray-500 focus:border-blue-400 outline-none"
                      style={{ width: "7rem", colorScheme: "dark" }}
                      value={machineStartTimes[machine.id] || "08:00"}
                      onChange={(e) => handleStartTimeChange(machine.id, e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    {caps.map((c) => (
                      <span key={c} className="text-[10px] px-1.5 py-0.5 bg-gray-700 rounded">{c}</span>
                    ))}
                  </div>
                  <span className="text-sm text-gray-300 ml-2">{entries.length}건</span>
                </div>
              </div>

              {entries.length === 0 ? (
                <div className="px-4 py-6 text-center text-gray-400 text-sm">
                  우측에서 작업을 드래그하여 배정하세요
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-500 text-xs border-b">
                      <th className="px-2 py-1.5 text-left w-8">#</th>
                      <th className="px-2 py-1.5 text-left">작업명</th>
                      <th className="px-2 py-1.5 text-left w-14">수량</th>
                      <th className="px-2 py-1.5 text-left w-24">구분</th>
                      <th className="px-2 py-1.5 text-center w-20">소요(시간)</th>
                      <th className="px-2 py-1.5 text-left w-20">예상완료</th>
                      <th className="px-2 py-1.5 text-left w-24">납기</th>
                      <th className="px-2 py-1.5 text-center w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const over = isOverDeadline(entry.end_time, entry.deadline);
                      const isReorderHover = reorderTarget === entry.id;
                      return (
                        <tr
                          key={entry.id}
                          draggable
                          onDragStart={() => {
                            setDragEntryId(entry.id);
                            setDragOrderId(null);
                          }}
                          onDragEnd={() => { setDragEntryId(null); setReorderTarget(null); }}
                          className={`border-t cursor-grab active:cursor-grabbing ${
                            over ? "bg-red-50" : "hover:bg-gray-50"
                          } ${dragEntryId === entry.id ? "opacity-40" : ""} ${
                            isReorderHover ? "border-t-2 border-t-blue-500" : ""
                          }`}
                          onDragOver={(e) => {
                            if (dragEntryId !== null && dragEntryId !== entry.id) {
                              e.preventDefault();
                              e.stopPropagation();
                              setReorderTarget(entry.id);
                            }
                          }}
                          onDragLeave={() => {
                            if (reorderTarget === entry.id) setReorderTarget(null);
                          }}
                          onDrop={(e) => {
                            if (dragEntryId !== null && dragEntryId !== entry.id) {
                              e.preventDefault();
                              e.stopPropagation();
                              setReorderTarget(null);
                              const fromEntry = schedule.find((s) => s.id === dragEntryId);
                              if (fromEntry && fromEntry.machine_id === machine.id) {
                                const currentEntries = [...entries];
                                const fromIdx = currentEntries.findIndex((e) => e.id === dragEntryId);
                                const toIdx = currentEntries.findIndex((e) => e.id === entry.id);
                                if (fromIdx >= 0 && toIdx >= 0) {
                                  const [moved] = currentEntries.splice(fromIdx, 1);
                                  currentEntries.splice(toIdx, 0, moved);
                                  handleReorder(machine.id, currentEntries.map((e) => e.id));
                                }
                              }
                              setDragEntryId(null);
                              setDragOrderId(null);
                            }
                          }}
                        >
                          <td className="px-2 py-1.5 text-gray-400 text-xs">{entry.sequence}</td>
                          <td className="px-2 py-1.5">
                            <span className="font-medium text-xs">{entry.product_name}</span>
                            <span className="text-gray-400 text-xs ml-1">({entry.component})</span>
                          </td>
                          <td className="px-2 py-1.5 text-xs">{entry.quantity_sheets}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${
                              PROCESS_COLORS[entry.special_process] || "bg-gray-100 text-gray-600 border-gray-200"
                            }`}>
                              {entry.special_process}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              className="w-16 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-center font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                              value={entry.duration_minutes ? Math.round(entry.duration_minutes / 60) : ""}
                              placeholder="시간"
                              onChange={(e) => handleDurationChange(entry.id, Number(e.target.value) || 0)}
                            />
                          </td>
                          <td className={`px-2 py-1.5 font-mono text-xs ${over ? "text-red-600 font-bold" : "text-gray-700"}`}>
                            {formatEndTime(entry.end_time)}
                          </td>
                          <td className={`px-2 py-1.5 text-xs ${deadlineColor(entry.deadline)}`}>
                            {entry.deadline}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button
                              onClick={() => handleUnassign(entry.id)}
                              disabled={loading}
                              className="text-red-400 hover:text-red-600 text-xs"
                              title="배정 해제"
                            >
                              ✕
                            </button>
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

      {/* 우측: 배정 대기 주문 목록 */}
      <div className="w-96 bg-white rounded-xl border shadow-sm flex flex-col overflow-hidden shrink-0">
        <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-900">배정 대기</h3>
            <p className="text-xs text-gray-500">{orders.length}건</p>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700"
          >
            {showAddForm ? "닫기" : "+ 주문 추가"}
          </button>
        </div>

        {showAddForm && (
          <div className="p-3 border-b bg-blue-50/50">
            <form onSubmit={handleAddOrder} className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text" placeholder="작업지시번호"
                  className="border rounded px-2 py-1.5 text-xs w-full col-span-2"
                  value={newOrder.order_code}
                  onChange={(e) => setNewOrder({ ...newOrder, order_code: e.target.value })}
                />
                <input
                  type="text" placeholder="제품명 *" required
                  className="border rounded px-2 py-1.5 text-xs w-full"
                  value={newOrder.product_name}
                  onChange={(e) => setNewOrder({ ...newOrder, product_name: e.target.value })}
                />
                <input
                  type="text" placeholder="구성 (표지, 본문 등)"
                  className="border rounded px-2 py-1.5 text-xs w-full"
                  value={newOrder.component}
                  onChange={(e) => setNewOrder({ ...newOrder, component: e.target.value })}
                />
                <input
                  type="number" placeholder="수량 *" required min="1"
                  className="border rounded px-2 py-1.5 text-xs w-full"
                  value={newOrder.quantity_sheets || ""}
                  onChange={(e) => setNewOrder({ ...newOrder, quantity_sheets: Number(e.target.value) })}
                />
                <div>
                  <label className="text-[10px] text-gray-500">납기일</label>
                  <input
                    type="date" required
                    className="border rounded px-2 py-1.5 text-xs w-full"
                    value={newOrder.deadline}
                    onChange={(e) => setNewOrder({ ...newOrder, deadline: e.target.value })}
                  />
                </div>
                <select
                  className="border rounded px-2 py-1.5 text-xs w-full"
                  value={newOrder.special_process}
                  onChange={(e) => setNewOrder({ ...newOrder, special_process: e.target.value })}
                >
                  {PROCESSES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input
                  type="text" placeholder="비고"
                  className="border rounded px-2 py-1.5 text-xs w-full"
                  value={newOrder.notes}
                  onChange={(e) => setNewOrder({ ...newOrder, notes: e.target.value })}
                />
              </div>
              <button type="submit" className="w-full py-1.5 bg-blue-600 text-white rounded text-xs font-medium">
                등록
              </button>
            </form>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {orders.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-8">
              모든 주문이 배정되었습니다
            </div>
          ) : (
            orders.map((order) => {
              const days = daysUntilDeadline(order.deadline);
              return (
                <div
                  key={order.id}
                  draggable
                  onDragStart={() => onDragStartOrder(order.id)}
                  className={`p-2.5 rounded-lg border cursor-grab active:cursor-grabbing transition hover:shadow-sm ${
                    dragOrderId === order.id ? "opacity-40" : ""
                  } ${days < 0 ? "border-red-300 bg-red-50" : days <= 2 ? "border-orange-200 bg-orange-50/50" : "border-gray-200 bg-white"}`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${
                          PROCESS_COLORS[order.special_process] || "bg-gray-100 text-gray-600 border-gray-200"
                        }`}>
                          {order.special_process}
                        </span>
                        <span className="text-xs text-gray-500 font-mono">{order.order_code || "-"}</span>
                      </div>
                      <p className={`text-xs font-mono shrink-0 ${deadlineColor(order.deadline)}`}>
                        {order.deadline}
                      </p>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <p className="font-medium text-sm truncate min-w-0 flex-1">{order.product_name}{order.component && `(${order.component})`}</p>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-sm font-medium">{order.quantity_sheets}매</span>
                        <p className={`text-xs ${days < 0 ? "text-red-600" : days <= 2 ? "text-orange-500" : "text-gray-400"}`}>
                          {days < 0 ? `${Math.abs(days)}일 초과` : days === 0 ? "오늘" : `D-${days}`}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
