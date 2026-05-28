"use client";

import { useEffect, useState } from "react";
import { useProcess } from "../components/ProcessContext";

interface Machine {
  id: number;
  name: string;
  description: string;
  speed_sheets_per_hour: number;
  setup_time_minutes: number;
  capabilities: string;
  is_active: number;
  work_start_hour: number;
  work_end_hour: number;
  works_saturday: number;
  works_sunday: number;
}

const ALL_CAPABILITIES = ["일반", "항바니쉬", "UV", "IR코팅", "양면", "패키지", "비닐스티커", "유포지", "OHP"];

export default function MachinesPage() {
  const { factory, processLine } = useProcess();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    speed_sheets_per_hour: 2000,
    setup_time_minutes: 30,
    capabilities: ["일반"] as string[],
    work_start_hour: 8,
    work_end_hour: 22,
    works_saturday: true,
    works_sunday: false,
    is_active: true,
  });
  const [showForm, setShowForm] = useState(false);

  const fetchMachines = async () => {
    const qs = `?factory=${encodeURIComponent(factory)}&process_line=${encodeURIComponent(processLine)}`;
    const res = await fetch(`/api/machines${qs}`);
    setMachines(await res.json());
  };

  useEffect(() => {
    fetchMachines();
  }, [factory, processLine]);

  const handleEdit = (m: Machine) => {
    let caps: string[] = [];
    try {
      caps = JSON.parse(m.capabilities);
    } catch {
      caps = [];
    }
    setForm({
      name: m.name,
      description: m.description,
      speed_sheets_per_hour: m.speed_sheets_per_hour,
      setup_time_minutes: m.setup_time_minutes,
      capabilities: caps,
      work_start_hour: m.work_start_hour,
      work_end_hour: m.work_end_hour,
      works_saturday: m.works_saturday === 1,
      works_sunday: m.works_sunday === 1,
      is_active: m.is_active === 1,
    });
    setEditingId(m.id);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId) {
      await fetch(`/api/machines/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, factory, process_line: processLine }),
      });
    } else {
      await fetch("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, factory, process_line: processLine }),
      });
    }
    setShowForm(false);
    setEditingId(null);
    fetchMachines();
  };

  const toggleCapability = (cap: string) => {
    setForm((prev) => ({
      ...prev,
      capabilities: prev.capabilities.includes(cap)
        ? prev.capabilities.filter((c) => c !== cap)
        : [...prev.capabilities, cap],
    }));
  };

  const parseCaps = (s: string): string[] => {
    try { return JSON.parse(s); } catch { return []; }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">기계 관리</h2>
        <button
          onClick={() => {
            setShowForm(true);
            setEditingId(null);
            setForm({
              name: "", description: "", speed_sheets_per_hour: 2000, setup_time_minutes: 30,
              capabilities: ["일반"], work_start_hour: 8, work_end_hour: 22,
              works_saturday: true, works_sunday: false, is_active: true,
            });
          }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
        >
          + 기계 추가
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <h3 className="font-bold text-lg mb-4">{editingId ? "기계 수정" : "새 기계"}</h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">기계명 *</label>
                <input
                  type="text" required
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">설명</label>
                <input
                  type="text"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">시간당 처리량 (매)</label>
                <input
                  type="number" min="1"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={form.speed_sheets_per_hour}
                  onChange={(e) => setForm({ ...form, speed_sheets_per_hour: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">셋업 시간 (분)</label>
                <input
                  type="number" min="0"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={form.setup_time_minutes}
                  onChange={(e) => setForm({ ...form, setup_time_minutes: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">근무 시작 (시)</label>
                <input
                  type="number" min="0" max="23"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={form.work_start_hour}
                  onChange={(e) => setForm({ ...form, work_start_hour: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">근무 종료 (시)</label>
                <input
                  type="number" min="0" max="24"
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={form.work_end_hour}
                  onChange={(e) => setForm({ ...form, work_end_hour: Number(e.target.value) })}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">가능 공정</label>
              <div className="flex flex-wrap gap-2">
                {ALL_CAPABILITIES.map((cap) => (
                  <button
                    key={cap}
                    type="button"
                    onClick={() => toggleCapability(cap)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                      form.capabilities.includes(cap)
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-600 border-gray-300 hover:border-blue-400"
                    }`}
                  >
                    {cap}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.works_saturday}
                  onChange={(e) => setForm({ ...form, works_saturday: e.target.checked })}
                />
                토요일 가동
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.works_sunday}
                  onChange={(e) => setForm({ ...form, works_sunday: e.target.checked })}
                />
                일요일 가동
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                활성화
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingId(null); }}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm"
              >
                취소
              </button>
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                {editingId ? "수정" : "등록"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {machines.map((m) => (
          <div key={m.id} className={`bg-white rounded-xl shadow-sm border p-5 ${!m.is_active ? "opacity-50" : ""}`}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-bold text-lg">{m.name}</h3>
                <p className="text-sm text-gray-500">{m.description}</p>
              </div>
              <button
                onClick={() => handleEdit(m)}
                className="text-blue-600 hover:text-blue-800 text-sm font-medium"
              >
                수정
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm mb-3">
              <div className="text-gray-500">시간당 처리량</div>
              <div className="font-medium">{m.speed_sheets_per_hour.toLocaleString()} 매</div>
              <div className="text-gray-500">셋업 시간</div>
              <div className="font-medium">{m.setup_time_minutes}분</div>
              <div className="text-gray-500">근무 시간</div>
              <div className="font-medium">{m.work_start_hour}시 ~ {m.work_end_hour}시</div>
              <div className="text-gray-500">토/일 가동</div>
              <div className="font-medium">{m.works_saturday ? "토O" : "토X"} / {m.works_sunday ? "일O" : "일X"}</div>
            </div>
            <div className="flex flex-wrap gap-1">
              {parseCaps(m.capabilities).map((cap) => (
                <span key={cap} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">
                  {cap}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
