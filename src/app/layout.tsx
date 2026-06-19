import type { Metadata } from "next";
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
      <head>
        {/* 눈누 인기 폰트 Pretendard (동적 서브셋 웹폰트) */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@latest/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-full flex flex-col bg-[#f3f3f3] text-[#1b1b1b]">
        <AuthProvider>
          <ProcessProvider>
            <NavBar />
            <main className="w-full px-10 py-5 flex-1">
              {children}
            </main>
          </ProcessProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
