"use client";

import { useEffect, useState } from "react";
import { PROCESS_LINES, roleCanEditLine } from "@/lib/factory-config";
import { useAuth } from "../components/AuthContext";

interface Machine {
  id: number;
  name: string;
  is_active: number;
}

// 공정 라인 하나의 설비 목록 열. 추가/수정/삭제/드래그 순서변경을 모두 이 라인 안에서 처리한다.
function MachineColumn({ processLine, isAdmin }: { processLine: string; isAdmin: boolean }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
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

  const startEdit = (m: Machine) => {
    setEditingId(m.id);
    setEditName(m.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  const saveEdit = async (m: Machine) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === m.name) { cancelEdit(); return; }
    setLoading(true);
    await fetch(`/api/machines/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
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
                <input
                  type="text"
                  autoFocus
                  className="flex-1 min-w-0 border px-2 py-1 text-sm"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(m);
                    if (e.key === "Escape") cancelEdit();
                  }}
                />
              ) : (
                <span className={`flex-1 min-w-0 text-sm font-medium ${m.is_active ? "text-gray-900" : "text-gray-400"}`}>
                  {m.name}
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
