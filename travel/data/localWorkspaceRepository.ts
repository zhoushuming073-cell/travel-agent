import type { WorkspaceRepository } from "../../worker/domain/types.ts";
import type { WorkspaceSnapshot } from "../types.ts";

const STORAGE_KEY = "travel-workspaces-v3";
const SCHEMA_VERSION = 5;

interface StoredEnvelope {
  schemaVersion: number;
  workspaces: WorkspaceSnapshot[];
}

function isWorkspace(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.state === "string" && Array.isArray(record.alternatives) && Array.isArray(record.versions);
}

function read(): WorkspaceSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as StoredEnvelope | null;
    if (!value || ![3, 4, SCHEMA_VERSION].includes(value.schemaVersion) || !Array.isArray(value.workspaces)) return [];
    return value.workspaces.filter(isWorkspace);
  } catch {
    return [];
  }
}

function write(workspaces: WorkspaceSnapshot[]): void {
  const envelope: StoredEnvelope = { schemaVersion: SCHEMA_VERSION, workspaces: workspaces.slice(0, 20) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

export class LocalWorkspaceRepository implements WorkspaceRepository {
  async list(): Promise<WorkspaceSnapshot[]> {
    return read().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<WorkspaceSnapshot | null> {
    return read().find((workspace) => workspace.id === id) ?? null;
  }

  async save(workspace: WorkspaceSnapshot): Promise<void> {
    const workspaces = read().filter((item) => item.id !== workspace.id);
    write([workspace, ...workspaces]);
  }

  async remove(id: string): Promise<void> {
    write(read().filter((workspace) => workspace.id !== id));
  }
}

export const workspaceRepository = new LocalWorkspaceRepository();
