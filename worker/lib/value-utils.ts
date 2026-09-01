export const clamp = (value: unknown, min: number, max: number) =>
  Math.min(max, Math.max(min, Number(value) || min));

export const cleanText = (value: unknown, fallback = "") =>
  // Control characters are intentionally removed at this untrusted-text boundary.
  // eslint-disable-next-line no-control-regex
  String(value ?? fallback).replace(/[\u0000-\u001f]+/g, " ").trim();

export function minutesToTime(total: number) {
  const safe = Math.max(0, Math.round(total));
  return `${String(Math.floor(safe / 60) % 24).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function timeToMinutes(text: unknown, fallback: number) {
  const match = cleanText(text).match(/(\d{1,2}):(\d{2})/);
  return match ? clamp(Number(match[1]) * 60 + Number(match[2]), 0, 1439) : fallback;
}

export function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => item !== null && item !== undefined && item !== "") : [];
}

export function normalizeName(name: unknown) {
  return cleanText(name).replace(/[\s·•—－()（）景区风景名胜区旅游区]+/g, "").toLowerCase();
}
