export const HONG_KONG_V30_INCIDENT_FIXTURE = {
  city: "香港",
  startDate: "2027-09-10",
  days: 4,
  nights: 3,
  lodgingArea: "湾仔附近",
  prompt: "香港 4 天 3 晚，2027-09-10 出发，住湾仔附近；偏好高密度现代城市、特色交通、夜景、建筑和商业娱乐；不偏好自然、爬山、寺庙和普通商场。",
  simulatedLatency: {
    modelMs: 40_000,
    throttleMs: 65_000,
    searchMs: 3_000,
  },
} as const;
