export interface TrafficCoverageSummary {
  total: number;
  verified: number;
  estimated: number;
  coveragePercent: number;
  status: "target-met" | "partial" | "degraded";
}

export function summarizeTrafficCoverage(totalValue: unknown, verifiedValue: unknown): TrafficCoverageSummary {
  const total = Math.max(0, Math.round(Number(totalValue) || 0));
  const verified = Math.min(total, Math.max(0, Math.round(Number(verifiedValue) || 0)));
  const coveragePercent = total ? Math.round(verified / total * 1000) / 10 : 100;
  return { total, verified, estimated: total - verified, coveragePercent, status: coveragePercent < 60 ? "degraded" : coveragePercent >= 80 ? "target-met" : "partial" };
}
