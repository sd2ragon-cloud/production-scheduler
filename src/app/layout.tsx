import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "./components/NavBar";
import { ProcessProvider } from "./components/ProcessContext";

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
      <body className="min-h-full flex flex-col bg-gray-50">
        <ProcessProvider>
          <NavBar />
          <main className="max-w-7xl mx-auto px-4 py-4 flex-1 w-full">
            {children}
          </main>
        </ProcessProvider>
      </body>
    </html>
  );
}
