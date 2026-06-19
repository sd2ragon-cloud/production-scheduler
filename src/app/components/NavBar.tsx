"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { PROCESS_LINES, ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "@/lib/factory-config";
import { useProcess } from "./ProcessContext";
import { useAuth } from "./AuthContext";

const NAV_LINKS = [
  { href: "/", label: "대시보드" },
  { href: "/orders", label: "주문 관리" },
  { href: "/machines", label: "설비 관리" },
  { href: "/schedule", label: "스케줄 보기" },
];

export default function NavBar() {
  const { processLine, setProcessLine } = useProcess();
  const { role, isAdmin, passwords, refresh } = useAuth();
  const pathname = usePathname();
  const [selRole, setSelRole] = useState<AdminRole>("sheet");
  const [extUrl, setExtUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // 선택한 역할(모드)로 로그인. 그 역할 비밀번호가 아직 없으면 최초 설정(setup), 있으면 로그인(login).
  const adminLogin = async () => {
    const label = ROLE_LABELS[selRole];
    if (!passwords[selRole]) {
      const pw = window.prompt(`'${label}' 비밀번호를 새로 설정하세요 (8자 이상, 연속·반복·흔한 비밀번호 불가).\n이 비밀번호로 ${label} 편집 권한을 켭니다. 보는 사람에게는 알려주지 마세요.`);
      if (!pw) return;
      const r = await fetch("/api/auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup", role: selRole, password: pw }),
      });
      if (!r.ok) { alert((await r.json().catch(() => ({}))).error || "설정 실패"); return; }
      await refresh();
      alert(`'${label}' 비밀번호가 설정되고 모드가 켜졌습니다.`);
    } else {
      const pw = window.prompt(`'${label}' 비밀번호를 입력하세요.`);
      if (!pw) return;
      const r = await fetch("/api/auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", role: selRole, password: pw }),
      });
      if (!r.ok) { alert((await r.json().catch(() => ({}))).error || "로그인 실패"); return; }
      await refresh();
    }
  };

  const adminLogout = async () => {
    await fetch("/api/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    await refresh();
  };

  // 관리자 비밀번호 변경
  const adminChange = async () => {
    const cur = window.prompt("현재 비밀번호를 입력하세요.");
    if (!cur) return;
    const next = window.prompt("새 비밀번호를 입력하세요 (8자 이상, 연속·반복·흔한 비밀번호 불가).");
    if (!next) return;
    const r = await fetch("/api/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change", password: cur, newPassword: next }),
    });
    alert(r.ok ? "비밀번호가 변경되었습니다." : ((await r.json().catch(() => ({}))).error || "변경 실패"));
  };

  // 외부 접속 주소(Cloudflare 터널 URL)를 가져온다. 터널이 안 떠 있으면 빈 값 → 버튼 숨김.
  useEffect(() => {
    let alive = true;
    fetch("/api/tunnel")
      .then((r) => r.json())
      .then((d) => { if (alive && d && typeof d.url === "string") setExtUrl(d.url); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 클릭 = 외부 주소를 클립보드에 복사(휴대폰/외부망에 전달용). 권한 없으면 새 탭으로 연다.
  const copyExt = async () => {
    if (!extUrl) return;
    try {
      await navigator.clipboard.writeText(extUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.open(extUrl, "_blank");
    }
  };

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-black/[0.08] shadow-sm">
      <div className="w-full px-10 py-2 flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          <a href="/" className="text-[15px] font-semibold text-gray-900 mr-4">생산 스케줄링</a>
          {NAV_LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <a
                key={l.href}
                href={l.href}
                className={`px-3 py-1.5 text-[13px] rounded-md transition ${
                  active
                    ? "bg-[#0078D4]/10 text-[#0078D4] font-semibold"
                    : "font-medium text-gray-600 hover:text-gray-900 hover:bg-black/[0.05]"
                }`}
              >
                {l.label}
              </a>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          {isAdmin ? (
            <div className="flex items-center gap-1.5">
              <span className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-blue-50 text-[#0078D4] whitespace-nowrap">{role ? ROLE_LABELS[role] : "관리자"} 모드</span>
              <button onClick={adminChange} title="현재 모드의 비밀번호 변경" className="px-2.5 py-1 text-xs font-medium rounded-md border border-black/10 bg-white text-gray-600 hover:bg-black/[0.03] transition whitespace-nowrap">비번 변경</button>
              <button onClick={adminLogout} className="px-3 py-1 text-xs font-medium rounded-md border border-black/10 bg-white text-gray-700 hover:bg-black/[0.03] transition whitespace-nowrap">로그아웃</button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <select
                value={selRole}
                onChange={(e) => setSelRole(e.target.value as AdminRole)}
                title="로그인할 관리자 모드 선택"
                className="px-2.5 py-1 text-xs font-medium rounded-md border border-black/10 bg-white text-gray-700 outline-none focus:border-[#0078D4]"
              >
                {ADMIN_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <button
                onClick={adminLogin}
                title="선택한 모드의 비밀번호를 입력하면 편집 권한이 켜집니다. 입력 전에는 보기 전용입니다."
                className="px-3 py-1 text-xs font-medium rounded-md border border-black/10 bg-white text-gray-700 hover:bg-black/[0.03] transition whitespace-nowrap"
              >
                🔒 {passwords[selRole] ? "로그인" : "비밀번호 설정"}
              </button>
            </div>
          )}
          {extUrl && (
            <button
              onClick={copyExt}
              title={`외부 접속 주소: ${extUrl}\n클릭하면 주소가 복사됩니다 (외부망·휴대폰에서 사용)`}
              className="px-3 py-1 text-xs font-medium rounded-md border border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 transition whitespace-nowrap"
            >
              {copied ? "주소 복사됨!" : "🌐 외부 접속 주소"}
            </button>
          )}
          <div className="flex gap-0.5 bg-black/[0.06] p-0.5 rounded-lg">
            {PROCESS_LINES.map((p) => (
              <button
                key={p}
                onClick={() => setProcessLine(p)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                  processLine === p
                    ? "bg-white shadow-sm text-gray-900"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
