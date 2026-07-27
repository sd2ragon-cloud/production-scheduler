"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { DEFAULT_PROCESS } from "@/lib/factory-config";

interface ProcessContextType {
  processLine: string;
  setProcessLine: (p: string) => void;
}

const ProcessContext = createContext<ProcessContextType | null>(null);

const STORAGE_KEY = "processLine"; // 선택한 라인 탭(매엽/윤전/제책)을 새로고침·이동 후에도 유지

export function ProcessProvider({ children }: { children: ReactNode }) {
  // SSR·최초 렌더는 DEFAULT로(하이드레이션 불일치 방지), 마운트 후 저장값으로 복원한다.
  const [processLine, setProcessLineState] = useState(DEFAULT_PROCESS);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved !== processLine) setProcessLineState(saved);
    } catch {
      /* localStorage 접근 불가 시 무시 */
    }
    // 최초 1회만 복원
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setProcessLine = (p: string) => {
    setProcessLineState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* 저장 실패해도 화면 전환은 정상 동작 */
    }
  };

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
