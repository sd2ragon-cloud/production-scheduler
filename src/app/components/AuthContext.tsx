"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { type AdminRole } from "@/lib/factory-config";

interface AuthState {
  role: AdminRole | null;                       // 로그인된 관리자 역할 (없으면 보기 전용)
  isAdmin: boolean;                              // 어느 역할이든 로그인됐는지 (편집 UI 노출 여부)
  passwords: Record<AdminRole, boolean>;         // 역할별 비밀번호 설정 여부 (로그인/최초설정 분기)
  loaded: boolean;                               // 서버 상태를 한 번이라도 받아왔는지
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<AdminRole | null>(null);
  const [passwords, setPasswords] = useState<Record<AdminRole, boolean>>({ sheet: true, wireless: true });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth", { cache: "no-store" });
      const d = await r.json();
      setRole(d.role ?? null);
      if (d.passwords && typeof d.passwords === "object") {
        setPasswords({ sheet: !!d.passwords.sheet, wireless: !!d.passwords.wireless });
      }
    } catch {
      /* 네트워크 오류 시 기본값(보기 전용) 유지 */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <AuthContext.Provider value={{ role, isAdmin: role !== null, passwords, loaded, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
