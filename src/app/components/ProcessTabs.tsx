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
    <div className="mb-4">
      <div className="flex gap-1 mb-2">
        {FACTORIES.map((f) => (
          <button
            key={f}
            onClick={() => {
              onFactoryChange(f);
              onProcessChange(FACTORY_PROCESS_MAP[f][0]);
            }}
            className={`px-5 py-2 rounded-t-lg text-sm font-bold border-b-2 transition ${
              factory === f
                ? "bg-gray-800 text-white border-gray-800"
                : "bg-gray-100 text-gray-500 border-transparent hover:bg-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 inline-flex">
        {processes.map((p) => (
          <button
            key={p}
            onClick={() => onProcessChange(p)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
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
