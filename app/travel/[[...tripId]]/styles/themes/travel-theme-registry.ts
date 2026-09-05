export const TRAVEL_THEME_IDS = [
  "arctic-blue",
  "ivory-coral",
  "lavender-indigo",
  "aqua-sand",
  "graphite-violet",
  "sky-peach",
  "champagne-navy",
  "rose-slate",
  "mint-cobalt",
  "sunset-lilac",
] as const;

export type TravelThemeId = (typeof TRAVEL_THEME_IDS)[number];

export const TRAVEL_THEMES = [
  { id: "arctic-blue", name: "Arctic Blue", nameZh: "极地雾蓝", description: "中性雾白与克制的旅行蓝，清晰、轻盈的默认主题。", preview: { canvas: "#F7F7F8", sidebar: "#F1F2F5", surface: "#FFFFFF", brand: "#5768EB", accent: "#5768EB", text: "#242630" } },
  { id: "ivory-coral", name: "Ivory Coral", nameZh: "象牙白 × 珊瑚橙", description: "温暖、有生活方式感，适合旅行内容与灵感场景。", preview: { canvas: "#FBF8F3", sidebar: "#F4ECE4", surface: "#FFFDF9", brand: "#EF7D64", accent: "#EF7D64", text: "#302A27" } },
  { id: "lavender-indigo", name: "Lavender Indigo", nameZh: "薰衣草紫 × 靛青", description: "柔和 AI 感，适合突出智能体与规划能力。", preview: { canvas: "#F7F5FB", sidebar: "#EEEAF7", surface: "#FFFFFF", brand: "#6C5CE7", accent: "#6C5CE7", text: "#262038" } },
  { id: "aqua-sand", name: "Aqua Sand", nameZh: "湖水青 × 沙砾白", description: "轻旅行感最强，像精品旅行网站而不是后台系统。", preview: { canvas: "#F8F7F2", sidebar: "#EDF4F4", surface: "#FFFFFF", brand: "#3C9FAF", accent: "#3C9FAF", text: "#24363A" } },
  { id: "graphite-violet", name: "Graphite Violet", nameZh: "石墨灰 × 蓝紫", description: "冷静、现代，适合强调专业工作台属性。", preview: { canvas: "#F7F7FA", sidebar: "#ECEEF3", surface: "#FFFFFF", brand: "#625BFF", accent: "#625BFF", text: "#1F222A" } },
  { id: "sky-peach", name: "Sky Peach", nameZh: "天空蓝 × 蜜桃粉", description: "更年轻、亲和，适合轻旅行与社交分享。", preview: { canvas: "#F8FBFE", sidebar: "#EDF5FB", surface: "#FFFFFF", brand: "#4C9CEB", accent: "#FF9B8B", text: "#203047" } },
  { id: "champagne-navy", name: "Champagne Navy", nameZh: "香槟金 × 海军蓝", description: "精品酒店与高端旅行气质，侧边栏仍保持明亮。", preview: { canvas: "#FAF8F4", sidebar: "#F3EFE7", surface: "#FFFDF9", brand: "#C99A4C", accent: "#315C8C", text: "#1E2C43" } },
  { id: "rose-slate", name: "Rose Slate", nameZh: "灰粉 × 岩板蓝", description: "更有审美与编辑感，适合强调旅行灵感内容。", preview: { canvas: "#FAF7F8", sidebar: "#F1E9EC", surface: "#FFFFFF", brand: "#D9819B", accent: "#617A98", text: "#2B2B33" } },
  { id: "mint-cobalt", name: "Mint Cobalt", nameZh: "薄荷白 × 钴蓝", description: "清爽且速度感强，特别适合地图、路线与交通界面。", preview: { canvas: "#F5FBFA", sidebar: "#E8F3F1", surface: "#FFFFFF", brand: "#315FD6", accent: "#65C9B4", text: "#17313A" } },
  { id: "sunset-lilac", name: "Sunset Lilac", nameZh: "落日杏 × 淡丁香", description: "创意、轻盈，适合首页、灵感库与探索型体验。", preview: { canvas: "#FBF8FB", sidebar: "#F1ECF6", surface: "#FFFFFF", brand: "#E88964", accent: "#8A74D6", text: "#2A2230" } },
] as const satisfies ReadonlyArray<{
  id: TravelThemeId;
  name: string;
  nameZh: string;
  description: string;
  preview: { canvas: string; sidebar: string; surface: string; brand: string; accent: string; text: string };
}>;
