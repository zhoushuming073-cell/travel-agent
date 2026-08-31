import type { Metadata } from "next";
import { TRAVEL_THEME_IDS } from "./travel/[[...tripId]]/styles/themes/travel-theme-registry.ts";
import "./globals.css";

const DEFAULT_TRAVEL_THEME = "arctic-blue";
const TRAVEL_THEME_STORAGE_KEY = "travel-ui-theme";
const travelThemeBootScript = `(() => {
  const themes = ${JSON.stringify(TRAVEL_THEME_IDS)};
  let theme = "${DEFAULT_TRAVEL_THEME}";
  try {
    const stored = localStorage.getItem("${TRAVEL_THEME_STORAGE_KEY}");
    if (stored && themes.includes(stored)) theme = stored;
  } catch {}
  document.documentElement.dataset.travelTheme = theme;
})();`;

export const metadata: Metadata = {
  metadataBase: new URL("https://smart-travel-cn-2026.zhoushuming.chatgpt.site"),
  title: "智能旅游助手",
  description: "DeepSeek V4 Flash 需求理解、DeepSeek V4 Pro 联网核验与约束决策驱动的中国旅行决策系统。",
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
    icon: [{ url: "/favicon.ico", type: "image/x-icon" }, { url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-travel-theme={DEFAULT_TRAVEL_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: travelThemeBootScript }}/>
        <link rel="preload" href="/animations/face-scanning.json" as="fetch" type="application/json" crossOrigin="anonymous"/>
        <link rel="preload" href="/animations/search.json" as="fetch" type="application/json" crossOrigin="anonymous"/>
      </head>
      <body>{children}</body>
    </html>
  );
}
