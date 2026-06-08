"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import { DEFAULT_PROCESS } from "@/lib/factory-config";

interface ProcessContextType {
  processLine: string;
  setProcessLine: (p: string) => void;
}

const ProcessContext = createContext<ProcessContextType | null>(null);

export function ProcessProvider({ children }: { children: ReactNode }) {
  const [processLine, setProcessLine] = useState(DEFAULT_PROCESS);

  return (
    <ProcessContext.Provider value={{ processLine, setProcessLine }}>
      {children}
    </ProcessContext.Provider>
  );
}

export function useProcess() {
  const ctx = useContext(ProcessContext);
  if (!ctx) throw new Error("useProcess must be used within ProcessProvider");
  return ctx;
}
