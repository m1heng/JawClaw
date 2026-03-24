import type { TaskStore, TaskRecord, TaskStoreFilter } from "../task-store.js";

/**
 * In-memory TaskStore for tests. Not persistent.
 */
export class MemoryTaskStore implements TaskStore {
  private records = new Map<string, TaskRecord>();

  async create(record: TaskRecord): Promise<void> {
    this.records.set(record.taskId, { ...record });
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    const r = this.records.get(taskId);
    return r ? { ...r } : null;
  }

  async update(
    taskId: string,
    patch: Partial<TaskRecord>,
  ): Promise<void> {
    const existing = this.records.get(taskId);
    if (!existing) return;
    this.records.set(taskId, { ...existing, ...patch });
  }

  async list(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    const results: TaskRecord[] = [];
    for (const rec of this.records.values()) {
      if (filter?.state !== undefined && rec.state !== filter.state) continue;
      if (filter?.delivered !== undefined && rec.delivered !== filter.delivered)
        continue;
      results.push({ ...rec });
    }
    return results;
  }

  async claim(taskId: string, workerId: string): Promise<boolean> {
    const rec = this.records.get(taskId);
    if (!rec || rec.state !== "queued") return false;
    rec.state = "running";
    rec.workerId = workerId;
    rec.updatedAt = new Date().toISOString();
    return true;
  }

  async claimResults(): Promise<TaskRecord[]> {
    const results: TaskRecord[] = [];
    for (const rec of this.records.values()) {
      if (
        (rec.state === "completed" || rec.state === "failed" || rec.state === "cancelled") &&
        !rec.delivered
      ) {
        results.push({ ...rec });
      }
    }
    return results;
  }
}
