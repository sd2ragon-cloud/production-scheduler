"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import { DEFAULT_FACTORY, DEFAULT_PROCESS, FACTORY_PROCESS_MAP } from "@/lib/factory-config";

interface ProcessContextType {
  factory: string;
  processLine: string;
  setFactory: (f: string) => void;
  setProcessLine: (p: string) => void;
  switchFactory: (f: string) => void;
}

const ProcessContext = createContext<ProcessContextType | null>(null);

export function ProcessProvider({ children }: { children: ReactNode }) {
  const [factory, setFactory] = useState(DEFAULT_FACTORY);
  const [processLine, setProcessLine] = useState(DEFAULT_PROCESS);

  const switchFactory = (f: string) => {
    setFactory(f);
    setProcessLine(FACTORY_PROCESS_MAP[f][0]);
  };

  return (
    <ProcessContext.Provider value={{ factory, processLine, setFactory, setProcessLine, switchFactory }}>
      {children}
    </ProcessContext.Provider>
  );
}

export function useProcess() {
  const ctx = useContext(ProcessContext);
  if (!ctx) throw new Error("useProcess must be used within ProcessProvider");
  return ctx;
}
