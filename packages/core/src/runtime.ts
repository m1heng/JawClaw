import type { TaskDispatch, TaskResult } from "./types.js";

// ── Task state machine ──────────────────────────────────────────────
//
//         submit()          claim()
// PENDING ───────► QUEUED ───────► RUNNING
//                    │                │
//                    │ cancel()       │ cancel()
//                    ▼                ▼
//               CANCELLED         CANCELLED
//                                     │
//                           ┌─────────┼─────────┐
//                           ▼                   ▼
//                      COMPLETED             FAILED
//
// Single-process shortcut: submit() → RUNNING directly (skip QUEUED).

export type TaskState =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStatus = {
  taskId: string;
  state: TaskState;
  currentTurn?: number;
  description: string;
  startedAt: string;
  updatedAt: string;
};

// ── HandRuntime — the only interface Mouth sees ─────────────────────

export type HandRuntime = {
  /** Submit a task. Returns taskId. */
  submit(task: TaskDispatch): Promise<string>;

  /** Request cancellation. Best-effort. */
  cancel(taskId: string): Promise<void>;

  /** Query a single task's status. */
  status(taskId: string): Promise<TaskStatus | null>;

  /** List active tasks. */
  list(): Promise<TaskStatus[]>;

  /**
   * Register a completion callback. Called once at startup.
   * The callback MUST return a Promise — runtime awaits it before
   * marking the result as delivered (at-least-once guarantee).
   *
   * - LocalRuntime: fires immediately when executor finishes.
   * - QueuedRuntime: fires when resultPoller finds completed+undelivered records.
   * - On Mouth restart: re-register, runtime replays undelivered results via start().
   */
  onComplete(
    cb: (result: TaskResult & { replyTo?: string }) => Promise<void>,
  ): void;

  /** Start the runtime (polls, crash recovery, etc.). */
  start(): Promise<void>;

  /** Stop the runtime. */
  stop(): Promise<void>;
};

// ── HandExecutor — pluggable execution on the worker side ───────────

import type { Shell } from "./providers/shell.js";

export type ExecutionContext = {
  /** Abort signal. Triggered when task is cancelled. */
  signal: AbortSignal;
  /** Progress callback. Called by executor each turn. */
  onProgress: (update: { currentTurn: number }) => void;
  shell: Shell;
  sessionsDir: string;
  /** True when resuming from checkpoint — executor should skip initial prologue. */
  resuming?: boolean;
};

export type HandExecutor = {
  readonly name: string; // "builtin" | "claude-code" | "codex"
  execute(
    task: TaskDispatch,
    ctx: ExecutionContext,
  ): Promise<TaskResult>;
};
