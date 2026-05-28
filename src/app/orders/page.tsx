"use client";

import { useEffect, useState } from "react";
import { useProcess } from "../components/ProcessContext";

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

const PROCESSES = ["일반", "항바니쉬", "UV", "IR코팅", "양면", "패키지"];

const emptyOrder = {
  order_code: "",
  product_name: "",
  component: "",
  quantity_sheets: 0,
  deadline: "",
  special_process: "일반",
  priority: 5,
  notes: "",
};

export default function OrdersPage() {
  const { factory, processLine } = useProcess();
  const [orders, setOrders] = useState<Order[]>([]);
  const [form, setForm] = useState(emptyOrder);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const fetchOrders = async () => {
    const qs = `?factory=${encodeURIComponent(factory)}&process_line=${encodeURIComponent(processLine)}`;
    const res = await fetch(`/api/orders${qs}`);
    setOrders(await res.json());
    setSelected(new Set());
  };

  useEffect(() => {
    fetchOrders();
  }, [factory, processLine]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId) {
      await fetch(`/api/orders/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, status: "pending", factory, process_line: processLine }),
      });
    } else {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, factory, process_line: processLine }),
      });
    }
    setForm(emptyOrder);
    setEditingId(null);
    setShowForm(false);
    fetchOrders();
  };

  const handleEdit = (order: Order) => {
    setForm({
      order_code: order.order_code,
      product_name: order.product_name,
      component: order.component,
      quantity_sheets: order.quantity_sheets,
      deadline: order.deadline,
      special_process: order.special_process,
      priority: order.priority,
      notes: order.notes,
    });
    setEditingId(order.id);
    setShowForm(true);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("삭제하시겠습니까?")) return;
    await fetch(`/api/orders/${id}`, { method: "DELETE" });
    fetchOrders();
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`선택한 ${selected.size}건을 삭제하시겠습니까?`)) return;
    await Promise.all(
      Array.from(selected).map((id) =>
        fetch(`/api/orders/${id}`, { method: "DELETE" })
      )
    );
    fetchOrders();
  };

  const handleResetStatus = async () => {
    for (const order of orders) {
      if (order.status === "scheduled") {
        await fetch(`/api/orders/${order.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...order, status: "pending" }),
        });
      }
    }
    fetchOrders();
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === orders.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(orders.map((o) => o.id)));
    }
  };

  const STATUS_LABELS: Record<string, { label: string; color: string }> = {
    pending: { label: "대기", color: "bg-yellow-100 text-yellow-800" },
    scheduled: { label: "배정됨", color: "bg-green-100 text-green-800" },
    completed: { label: "완료", color: "bg-gray-100 text-gray-600" },
  };

  const isAllSelected = orders.length > 0 && selected.size === orders.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">주문 관리</h2>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition"
            >
              선택 삭제 ({selected.size}건)
            </button>
          )}
          <button
            onClick={handleResetStatus}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 transition"
          >
            전체 대기 상태로
          </button>
          <button
            onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyOrder); }}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
          >
            + 주문 추가
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <h3 className="font-bold text-lg mb-4">{editingId ? "주문 수정" : "새 주문"}</h3>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">발주코드</label>
              <input
                type="text"
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.order_code}
                onChange={(e) => setForm({ ...form, order_code: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">제품명 *</label>
              <input
                type="text"
                required
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.product_name}
                onChange={(e) => setForm({ ...form, product_name: e.target.value })}
                placeholder="예: 국어1-2 가"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">구성(부분) *</label>
              <input
                type="text"
                required
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.component}
                onChange={(e) => setForm({ ...form, component: e.target.value })}
                placeholder="예: 표지, 본문1대, 부록3대"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">수량(매) *</label>
              <input
                type="number"
                required
                min="1"
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.quantity_sheets || ""}
                onChange={(e) => setForm({ ...form, quantity_sheets: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">납기일 *</label>
              <input
                type="date"
                required
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">특수공정</label>
              <select
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.special_process}
                onChange={(e) => setForm({ ...form, special_process: e.target.value })}
              >
                {PROCESSES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">우선순위 (1=낮음, 10=높음)</label>
              <input
                type="number"
                min="1"
                max="10"
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">비고</label>
              <input
                type="text"
                className="w-full border rounded-lg px-3 py-2 text-sm"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="감리, 거래처 등"
              />
            </div>
            <div className="col-span-2 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyOrder); }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm"
              >
                취소
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
              >
                {editingId ? "수정" : "등록"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-gray-600 text-left">
              <th className="px-3 py-2 w-10">
                <input
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleAll}
                  className="rounded border-gray-300"
                />
              </th>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">코드</th>
              <th className="px-3 py-2">제품명</th>
              <th className="px-3 py-2">구성</th>
              <th className="px-3 py-2">수량</th>
              <th className="px-3 py-2">납기</th>
              <th className="px-3 py-2">공정</th>
              <th className="px-3 py-2">우선</th>
              <th className="px-3 py-2">상태</th>
              <th className="px-3 py-2">비고</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const st = STATUS_LABELS[order.status] || STATUS_LABELS.pending;
              const isChecked = selected.has(order.id);
              return (
                <tr key={order.id} className={`border-t hover:bg-gray-50 ${isChecked ? "bg-blue-50" : ""}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(order.id)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-400">{order.id}</td>
                  <td className="px-3 py-2">{order.order_code}</td>
                  <td className="px-3 py-2 font-medium">{order.product_name}</td>
                  <td className="px-3 py-2">{order.component}</td>
                  <td className="px-3 py-2">{order.quantity_sheets}</td>
                  <td className="px-3 py-2">{order.deadline}</td>
                  <td className="px-3 py-2">{order.special_process}</td>
                  <td className="px-3 py-2">{order.priority}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${st.color}`}>
                      {st.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{order.notes}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleEdit(order)}
                        className="text-blue-600 hover:text-blue-800 text-xs"
                      >
                        수정
                      </button>
                      <button
                        onClick={() => handleDelete(order.id)}
                        className="text-red-600 hover:text-red-800 text-xs"
                      >
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {orders.length === 0 && (
          <div className="p-8 text-center text-gray-400">등록된 주문이 없습니다.</div>
        )}
      </div>
    </div>
  );
}
