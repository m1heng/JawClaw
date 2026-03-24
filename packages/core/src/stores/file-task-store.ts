import type { Shell } from "../providers/shell.js";
import type { TaskStore, TaskRecord, TaskStoreFilter } from "../task-store.js";

/**
 * File-based TaskStore. Each task is a JSON file at `{dir}/{taskId}.json`.
 * Suitable for single-process / single-machine usage.
 */
export class FileTaskStore implements TaskStore {
  constructor(
    private dir: string,
    private shell: Shell,
  ) {}

  private path(taskId: string): string {
    return `${this.dir}/${taskId}.json`;
  }

  async create(record: TaskRecord): Promise<void> {
    await this.shell.mkdir(this.dir);
    await this.shell.writeFile(
      this.path(record.taskId),
      JSON.stringify(record, null, 2) + "\n",
    );
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    try {
      const raw = await this.shell.readFile(this.path(taskId));
      return JSON.parse(raw) as TaskRecord;
    } catch {
      return null;
    }
  }

  async update(
    taskId: string,
    patch: Partial<TaskRecord>,
  ): Promise<void> {
    const existing = await this.get(taskId);
    if (!existing) return;
    const updated = { ...existing, ...patch };
    await this.shell.writeFile(
      this.path(taskId),
      JSON.stringify(updated, null, 2) + "\n",
    );
  }

  async list(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    let files: string[];
    try {
      files = await this.shell.listFiles(this.dir);
    } catch {
      return [];
    }

    const records: TaskRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        // listFiles returns full paths (e.g. ".jawclaw/tasks/abc.json")
        const raw = await this.shell.readFile(file);
        const rec = JSON.parse(raw) as TaskRecord;
        if (filter?.state !== undefined && rec.state !== filter.state) continue;
        if (filter?.delivered !== undefined && rec.delivered !== filter.delivered)
          continue;
        records.push(rec);
      } catch {
        // Skip corrupt files
      }
    }
    return records;
  }

  /**
   * Claim: safe for single-process (Node.js single-threaded).
   * For multi-process workers, replace with SQLite or DB with
   * conditional UPDATE ... WHERE state='queued'.
   */
  async claim(taskId: string, workerId: string): Promise<boolean> {
    const rec = await this.get(taskId);
    if (!rec || rec.state !== "queued") return false;
    await this.update(taskId, {
      state: "running",
      workerId,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async claimResults(): Promise<TaskRecord[]> {
    const all = await this.list({ delivered: false });
    return all.filter(
      (r) => r.state === "completed" || r.state === "failed" || r.state === "cancelled",
    );
  }
}
