/**
 * Checkpoint — a snapshot of a Hand agent's session at a given turn.
 * Used by BuiltinExecutor to enable resume-from-crash.
 */
export type Checkpoint = {
  taskId: string;
  turn: number;
  /** Serialized JSONL content of the session file. */
  session: string;
  createdAt: string;
};

export type CheckpointStore = {
  /** Save a checkpoint (overwrites if same taskId+turn exists). */
  save(cp: Checkpoint): Promise<void>;
  /** Load the latest checkpoint for a task. Returns null if none. */
  latest(taskId: string): Promise<Checkpoint | null>;
};
