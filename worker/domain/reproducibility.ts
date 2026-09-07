import type { ReproducibilitySnapshot } from "./types.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

export function stableHash(value: unknown) {
  const text = canonical(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function reproducibilitySnapshot(input: {
  request: unknown;
  candidates: unknown;
  facts: unknown;
  providers: unknown;
  model?: string;
  createdAt?: string;
}): ReproducibilitySnapshot {
  const requestHash = stableHash(input.request);
  const candidateSnapshotHash = stableHash(input.candidates);
  const factSnapshotHash = stableHash(input.facts);
  const providerSnapshotHash = stableHash(input.providers);
  const randomSeed = Number.parseInt(stableHash({ requestHash, candidateSnapshotHash, factSnapshotHash }), 16) >>> 0;
  return {
    version: "1.0",
    requestHash,
    candidateSnapshotHash,
    factSnapshotHash,
    providerSnapshotHash,
    randomSeed,
    model: input.model || "unknown",
    optimizer: "time-window-insertion+relocate+swap+2opt+lns-v2",
    promptVersion: "planner-contract-v3",
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
