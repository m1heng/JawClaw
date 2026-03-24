import type { TaskState } from "./runtime.js";

export type TaskRecord = {
  taskId: string;
  description: string;
  sourceChat: string;
  replyTo?: string;
  executor: string; // "builtin" | "claude-code" | "codex"

  // State
  state: TaskState;
  workerId?: string;
  currentTurn?: number;
  summary?: string;
  error?: string;
  /** Whether Mouth has consumed this result (Outbox pattern). */
  delivered: boolean;

  // Timestamps
  createdAt: string;
  updatedAt: string;
};

export type TaskStoreFilter = {
  state?: TaskState;
  delivered?: boolean;
};

export type TaskStore = {
  create(record: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | null>;
  update(
    taskId: string,
    patch: Partial<TaskRecord>,
  ): Promise<void>;
  list(filter?: TaskStoreFilter): Promise<TaskRecord[]>;

  /**
   * Claim a queued task (QUEUED → RUNNING).
   * Conditional write: only succeeds if current state is "queued".
   * Returns true if claimed, false if already taken.
   */
  claim(taskId: string, workerId: string): Promise<boolean>;

  /**
   * Read completed/failed tasks that haven't been delivered yet.
   * Does NOT mark them as delivered — caller must do so after
   * successful processing (at-least-once delivery guarantee).
   */
  claimResults(): Promise<TaskRecord[]>;
};
