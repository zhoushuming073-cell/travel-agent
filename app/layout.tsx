import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "智能旅游助手",
  description: "DeepSeek 两阶段需求整理与真实工具辅助的中国旅行规划助手。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
