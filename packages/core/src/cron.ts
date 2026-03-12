import { generateId } from "./id.js";
import type { CronEntry } from "./types.js";

type CronTask = CronEntry & {
  timer: ReturnType<typeof setTimeout>;
  callback: (description: string) => void;
};

export class CronScheduler {
  private tasks: Map<string, CronTask> = new Map();

  schedule(
    description: string,
    cronExpr: string,
    callback: (description: string) => void,
  ): string {
    const id = generateId().slice(0, 8);

    if (cronExpr.startsWith("once:")) {
      const delayMs = parseInt(cronExpr.slice(5), 10);
      if (isNaN(delayMs) || delayMs < 0)
        throw new Error(`Invalid delay: ${cronExpr}`);

      const timer = setTimeout(() => {
        callback(description);
        this.tasks.delete(id);
      }, delayMs);

      this.tasks.set(id, {
        id,
        description,
        cronExpr,
        nextRun: new Date(Date.now() + delayMs).toISOString(),
        timer,
        callback,
      });
    } else {
      // Simple recurring: parse interval from cron-like "*/N * * * *" (every N minutes)
      const intervalMs = parseCronInterval(cronExpr);
      const run = () => {
        callback(description);
        const task = this.tasks.get(id);
        if (task) {
          task.nextRun = new Date(Date.now() + intervalMs).toISOString();
        }
      };
      const timer = setInterval(run, intervalMs);

      this.tasks.set(id, {
        id,
        description,
        cronExpr,
        nextRun: new Date(Date.now() + intervalMs).toISOString(),
        timer,
        callback,
      });
    }

    return id;
  }

  list(): CronEntry[] {
    return [...this.tasks.values()].map(({ id, description, cronExpr, nextRun }) => ({
      id,
      description,
      cronExpr,
      nextRun,
    }));
  }

  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    clearTimeout(task.timer);
    clearInterval(task.timer);
    this.tasks.delete(id);
    return true;
  }

  destroy(): void {
    for (const task of this.tasks.values()) {
      clearTimeout(task.timer);
      clearInterval(task.timer);
    }
    this.tasks.clear();
  }
}

function parseCronInterval(expr: string): number {
  // MVP: support "*/N * * * *" (every N minutes) and "*/N * * * * *" (every N seconds)
  const parts = expr.trim().split(/\s+/);
  const first = parts[0];
  if (first && first.startsWith("*/")) {
    const n = parseInt(first.slice(2), 10);
    if (isNaN(n) || n <= 0) throw new Error(`Invalid cron expression: ${expr}`);
    // If 6 fields (with seconds), treat as seconds; otherwise minutes
    if (parts.length >= 6) return n * 1000;
    return n * 60 * 1000;
  }
  throw new Error(
    `Unsupported cron expression: "${expr}". MVP supports "*/N * * * *" (minutes) or "once:<ms>".`,
  );
}
