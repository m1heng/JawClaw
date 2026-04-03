/**
 * TaskQueue decouples task submission from execution.
 *
 * - Single-process: MemoryQueue (in-process array + Promise).
 * - Distributed: RedisQueue / SQSQueue.
 */
export type TaskQueue = {
  enqueue(taskId: string): Promise<void>;
  /** Blocking dequeue. Returns taskId, or null if stopped / signal aborted. */
  dequeue(signal?: AbortSignal): Promise<string | null>;
};
