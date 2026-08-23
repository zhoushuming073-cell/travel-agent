import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://smart-travel-cn-2026.zhoushuming.chatgpt.site"),
  title: "智能旅游助手",
  description: "GLM-5 需求理解、DeepSeek V4 Pro 联网核验与约束决策驱动的中国旅行规划助手。",
  openGraph: {
    title: "智能旅游助手",
    description: "从一句想法，到一份真正能出发的中国旅行行程。",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "智能旅游助手" }],
    locale: "zh_CN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "智能旅游助手",
    description: "从一句想法，到一份真正能出发的中国旅行行程。",
    images: ["/og.png"],
  },
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
