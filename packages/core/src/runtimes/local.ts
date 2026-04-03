import type { TaskDispatch, TaskResult } from "../types.js";
import type { Shell } from "../providers/shell.js";
import type {
  HandRuntime,
  HandExecutor,
  TaskStatus,
} from "../runtime.js";
import type { TaskStore, TaskRecord } from "../task-store.js";
import type { CheckpointStore } from "../checkpoint.js";

/**
 * LocalRuntime — single-process HandRuntime.
 *
 * Executes tasks in-process via a HandExecutor.
 * State is persisted to TaskStore so results survive process restarts
 * (Outbox pattern: crash recovery via claimResults on start).
 */
export class LocalRuntime implements HandRuntime {
  private callbacks: Array<
    (result: TaskResult & { replyTo?: string }) => Promise<void>
  > = [];
  private abortControllers = new Map<string, AbortController>();

  private checkpointStore?: CheckpointStore;

  constructor(
    private store: TaskStore,
    private executor: HandExecutor,
    private deps: { shell: Shell; sessionsDir: string },
    checkpointStore?: CheckpointStore,
  ) {
    this.checkpointStore = checkpointStore;
  }

  async start(): Promise<void> {
    // 1. Recover stale running tasks (interrupted by prior crash)
    const stale = await this.store.list({ state: "running" });
    for (const rec of stale) {
      let resumed = false;
      if (this.checkpointStore) {
        const cp = await this.checkpointStore.latest(rec.taskId);
        if (cp) {
          try {
            await this.resume(rec.taskId);
            resumed = true;
          } catch {
            // Resume failed — fall through to mark failed
          }
        }
      }
      if (!resumed) {
        await this.store.update(rec.taskId, {
          state: "failed",
          error: "Task interrupted by process restart (no checkpoint available)",
          delivered: false,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    // 2. Deliver completed/failed/cancelled but undelivered results.
    // Mark delivered AFTER callback succeeds (at-least-once).
    const pending = await this.store.claimResults();
    for (const rec of pending) {
      await this.deliver(this.toResult(rec));
      await this.store.update(rec.taskId, {
        delivered: true,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async stop(): Promise<void> {
    for (const ac of this.abortControllers.values()) {
      ac.abort();
    }
    this.abortControllers.clear();
  }

  async submit(task: TaskDispatch): Promise<string> {
    const ac = new AbortController();
    this.abortControllers.set(task.taskId, ac);

    const now = new Date().toISOString();
    await this.store.create({
      taskId: task.taskId,
      description: task.description,
      sourceChat: task.sourceChat,
      replyTo: task.replyTo,
      executor: this.executor.name,
      state: "running", // single-process: skip queued
      delivered: false,
      createdAt: now,
      updatedAt: now,
    });

    this.runExecutor(task, ac);
    return task.taskId;
  }

  async cancel(taskId: string): Promise<void> {
    // CAS: only cancel from running or queued states
    const rec = await this.store.get(taskId);
    if (!rec || (rec.state !== "running" && rec.state !== "queued")) return;

    // Mark cancelled in store BEFORE aborting the signal, so that
    // onExecutorDone() sees cancelled state even if the process exits
    // immediately after the abort (e.g. CLI killed by SIGTERM).
    await this.store.update(taskId, {
      state: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    this.abortControllers.get(taskId)?.abort();
  }

  async status(taskId: string): Promise<TaskStatus | null> {
    const rec = await this.store.get(taskId);
    return rec ? this.toStatus(rec) : null;
  }

  async list(): Promise<TaskStatus[]> {
    const running = await this.store.list({ state: "running" });
    return running.map((r) => this.toStatus(r));
  }

  onComplete(
    cb: (result: TaskResult & { replyTo?: string }) => Promise<void>,
  ): void {
    this.callbacks.push(cb);
  }

  /**
   * Resume a failed/crashed task from its latest checkpoint.
   * Restores the session JSONL and re-runs the executor.
   */
  async resume(taskId: string): Promise<string> {
    if (!this.checkpointStore) {
      throw new Error("Cannot resume: no CheckpointStore configured");
    }

    const rec = await this.store.get(taskId);
    if (!rec) throw new Error(`Task ${taskId} not found`);

    const cp = await this.checkpointStore.latest(taskId);
    if (!cp) throw new Error(`No checkpoint found for task ${taskId}`);

    // Restore session file from checkpoint
    const sessionPath = `${this.deps.sessionsDir}/hand_${taskId}.jsonl`;
    await this.deps.shell.writeFile(sessionPath, cp.session + "\n");

    // Reset task state to running
    await this.store.update(taskId, {
      state: "running",
      delivered: false,
      updatedAt: new Date().toISOString(),
    });

    const task: TaskDispatch = {
      taskId: rec.taskId,
      description: rec.description,
      sourceChat: rec.sourceChat,
      replyTo: rec.replyTo,
    };

    // Re-run via submit's execution path
    const ac = new AbortController();
    this.abortControllers.set(taskId, ac);

    this.runExecutor(task, ac, { resuming: true });
    return taskId;
  }

  // ── internal ──────────────────────────────────────────────────────

  /** Fire-and-forget executor run. Shared by submit() and resume(). */
  private runExecutor(
    task: TaskDispatch,
    ac: AbortController,
    opts?: { resuming?: boolean },
  ): void {
    this.executor
      .execute(task, {
        signal: ac.signal,
        onProgress: (u) =>
          this.store.update(task.taskId, {
            currentTurn: u.currentTurn,
            updatedAt: new Date().toISOString(),
          }),
        shell: this.deps.shell,
        sessionsDir: this.deps.sessionsDir,
        resuming: opts?.resuming,
      })
      .then(
        (result) => this.onExecutorDone(task, result),
        (err) =>
          this.onExecutorDone(task, {
            taskId: task.taskId,
            status: "failed",
            summary: "",
            error: err instanceof Error ? err.message : String(err),
          }),
      );
  }

  private async onExecutorDone(
    task: TaskDispatch,
    result: TaskResult,
  ): Promise<void> {
    this.abortControllers.delete(task.taskId);

    // Guard: if task was already cancelled, deliver cancelled result instead
    // of overwriting state with executor's outcome
    const current = await this.store.get(task.taskId);
    if (current?.state === "cancelled") {
      await this.store.update(task.taskId, { delivered: false, updatedAt: new Date().toISOString() });
      await this.deliver({ taskId: task.taskId, status: "cancelled", summary: "", replyTo: task.replyTo });
      await this.store.update(task.taskId, { delivered: true, updatedAt: new Date().toISOString() });
      return;
    }

    // Write result to store first (delivered=false so crash recovery can find it)
    await this.store.update(task.taskId, {
      state: result.status === "completed" ? "completed" : "failed",
      summary: result.summary,
      error: result.error,
      delivered: false,
      updatedAt: new Date().toISOString(),
    });

    // Deliver to callbacks, THEN mark delivered.
    // If process crashes between deliver and markDelivered, claimResults()
    // will redeliver on restart (at-least-once, idempotent on Mouth side).
    await this.deliver({ ...result, replyTo: task.replyTo });

    await this.store.update(task.taskId, {
      delivered: true,
      updatedAt: new Date().toISOString(),
    });
  }

  private async deliver(
    result: TaskResult & { replyTo?: string },
  ): Promise<void> {
    for (const cb of this.callbacks) await cb(result);
  }

  private toStatus(rec: TaskRecord): TaskStatus {
    return {
      taskId: rec.taskId,
      state: rec.state,
      currentTurn: rec.currentTurn,
      description: rec.description,
      startedAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  private toResult(
    rec: TaskRecord,
  ): TaskResult & { replyTo?: string } {
    return {
      taskId: rec.taskId,
      status:
        rec.state === "completed"
          ? "completed"
          : rec.state === "cancelled"
            ? "cancelled"
            : "failed",
      summary: rec.summary ?? "",
      error: rec.error,
      replyTo: rec.replyTo,
    };
  }
}
