"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { DEFAULT_PROCESS } from "@/lib/factory-config";

interface ProcessContextType {
  processLine: string;
  setProcessLine: (p: string) => void;
}

const ProcessContext = createContext<ProcessContextType | null>(null);

const STORAGE_KEY = "processLine"; // 선택한 라인 탭(매엽/윤전/제책)을 새로고침·이동 후에도 유지

// 이 PC(브라우저)를 구분하는 식별자 쿠키. 개인 계정이 없으므로 삭제 이력에서 '어느 PC'인지 알려면 필요하다.
// ps_device: 최초 1회 자동 생성(영구). ps_device_name: 사용자가 지정한 이름(선택).
function ensureDeviceCookie() {
  if (typeof document === "undefined") return;
  if (!/(?:^|;\s*)ps_device=/.test(document.cookie)) {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    document.cookie = `ps_device=${id}; path=/; max-age=${60 * 60 * 24 * 3650}; samesite=lax`;
  }
}

export function ProcessProvider({ children }: { children: ReactNode }) {
  // SSR·최초 렌더는 DEFAULT로(하이드레이션 불일치 방지), 마운트 후 저장값으로 복원한다.
  const [processLine, setProcessLineState] = useState(DEFAULT_PROCESS);

  useEffect(() => {
    ensureDeviceCookie(); // 삭제 이력에 '어느 PC'인지 남기기 위한 식별자
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
