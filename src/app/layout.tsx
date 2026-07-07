import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "./components/NavBar";
import { ProcessProvider } from "./components/ProcessContext";
import { AuthProvider } from "./components/AuthContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "생산 스케줄링 시스템",
  description: "인쇄 생산 스케줄 자동화",
};

// 크롬/OS 다크모드가 화면을 자동으로 어둡게 바꾸지 못하게 라이트로 고정(글자색이 흐려지는 문제 방지).
export const viewport: Viewport = {
  colorScheme: "only light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-gray-50">
        <AuthProvider>
          <ProcessProvider>
            <NavBar />
            <main className="w-full px-10 py-3 flex-1">
              {children}
            </main>
          </ProcessProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
