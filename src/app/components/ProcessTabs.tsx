"use client";

import { FACTORY_PROCESS_MAP, FACTORIES } from "@/lib/factory-config";

interface ProcessTabsProps {
  factory: string;
  processLine: string;
  onFactoryChange: (factory: string) => void;
  onProcessChange: (process: string) => void;
}

export default function ProcessTabs({ factory, processLine, onFactoryChange, onProcessChange }: ProcessTabsProps) {
  const processes = FACTORY_PROCESS_MAP[factory] || [];

  return (
    <div className="flex items-center gap-3 mb-3">
      <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
        {FACTORIES.map((f) => (
          <button
            key={f}
            onClick={() => {
              onFactoryChange(f);
              onProcessChange(FACTORY_PROCESS_MAP[f][0]);
            }}
            className={`px-3 py-1 rounded-md text-xs font-bold transition ${
              factory === f
                ? "bg-gray-800 text-white"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <span className="text-gray-300">|</span>
      <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
        {processes.map((p) => (
          <button
            key={p}
            onClick={() => onProcessChange(p)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition ${
              processLine === p
                ? "bg-white shadow text-gray-900"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
