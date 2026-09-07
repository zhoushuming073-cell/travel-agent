export interface AvailabilityWindow {
  date: string;
  dayIndex: number;
  start: string;
  end: string;
  lastAdmission?: string;
  confidence: number;
  sourceId: string;
  status: "verified" | "estimated" | "closed" | "unknown";
  exception?: string;
}

const clock = (hour: string, minute: string) => `${String(Number(hour)).padStart(2, "0")}:${minute}`;

export function parseAvailabilityWindows(input: {
  openingHours?: string | null;
  dates: string[];
  sourceId: string;
  verified?: boolean;
}): AvailabilityWindow[] {
  const text = String(input.openingHours || "").trim();
  if (!text) return input.dates.map((date, dayIndex) => ({ date, dayIndex, start: "", end: "", confidence: 0, sourceId: input.sourceId, status: "unknown" }));
  const ranges = [...text.matchAll(/(\d{1,2}):(\d{2})\s*[-—至]\s*(\d{1,2}):(\d{2})/g)]
    .map((match) => ({ start: clock(match[1], match[2]), end: clock(match[3], match[4]) }));
  const lastAdmissionMatch = text.match(/(?:最后入场|停止入场|last\s*admission)\D*(\d{1,2}):(\d{2})/i);
  const lastAdmission = lastAdmissionMatch ? clock(lastAdmissionMatch[1], lastAdmissionMatch[2]) : undefined;
  const closedWeekdays = [...text.matchAll(/周([一二三四五六日天])[^；;，,。]*(?:闭馆|关闭|休息)/g)].map((match) => match[1] === "天" ? "日" : match[1]);
  return input.dates.flatMap<AvailabilityWindow>((date, dayIndex) => {
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "Asia/Shanghai" }).format(new Date(`${date}T12:00:00+08:00`)).replace("周", "");
    if (closedWeekdays.includes(weekday)) return [{ date, dayIndex, start: "", end: "", confidence: input.verified ? 0.95 : 0.7, sourceId: input.sourceId, status: "closed", exception: `周${weekday}闭馆规则` }];
    if (!ranges.length) return [{ date, dayIndex, start: "", end: "", confidence: 0.2, sourceId: input.sourceId, status: "unknown" }];
    return ranges.map((range) => ({ date, dayIndex, ...range, lastAdmission, confidence: input.verified ? 0.9 : 0.62, sourceId: input.sourceId, status: input.verified ? "verified" : "estimated" }));
  });
}
