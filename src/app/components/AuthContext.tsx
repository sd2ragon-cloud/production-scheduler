"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

interface AuthState {
  isAdmin: boolean;       // 관리자 모드(편집 가능) 여부
  hasPassword: boolean;   // 관리자 비밀번호가 이미 설정돼 있는지 (false면 최초 설정 흐름)
  loaded: boolean;        // 서버 상태를 한 번이라도 받아왔는지
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasPassword, setHasPassword] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth", { cache: "no-store" });
      const d = await r.json();
      setIsAdmin(!!d.isAdmin);
      setHasPassword(!!d.hasPassword);
    } catch {
      /* 네트워크 오류 시 기본값(보기 전용) 유지 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <AuthContext.Provider value={{ isAdmin, hasPassword, loaded, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
