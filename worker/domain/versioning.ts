import type { ChangeSet, ItineraryPlan, ItineraryVersion } from "./types.ts";

export function appendItineraryVersion(
  versions: ItineraryVersion[],
  workspaceId: string,
  plan: ItineraryPlan,
  changeSet: ChangeSet | null,
  summary: string,
  createdBy: ItineraryVersion["createdBy"] = "agent",
  createdAt = new Date().toISOString(),
): ItineraryVersion[] {
  const parent = versions.at(-1) ?? null;
  const next: ItineraryVersion = {
    id: `${workspaceId}-v${(parent?.version ?? 0) + 1}`,
    workspaceId,
    version: (parent?.version ?? 0) + 1,
    parentVersionId: parent?.id ?? null,
    plan,
    changeSet,
    createdAt,
    createdBy,
    summary,
  };
  return [...versions, next];
}

export function restoreItineraryVersion(versions: ItineraryVersion[], versionId: string): ItineraryVersion | null {
  return versions.find((version) => version.id === versionId) ?? null;
}

export function isLinearVersionHistory(versions: ItineraryVersion[]): boolean {
  return versions.every((version, index) => {
    if (index === 0) return version.parentVersionId === null && version.version === 1;
    return version.parentVersionId === versions[index - 1].id && version.version === versions[index - 1].version + 1;
  });
}

