import { describe, it, expect } from "vitest";
import { MemoryTaskStore } from "../stores/memory-task-store.js";
import type { TaskRecord } from "../task-store.js";

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "t1",
    description: "test task",
    sourceChat: "mouth.jsonl",
    executor: "builtin",
    state: "running",
    delivered: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("MemoryTaskStore", () => {
  it("create and get", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord());
    const rec = await store.get("t1");
    expect(rec?.taskId).toBe("t1");
    expect(rec?.state).toBe("running");
  });

  it("get returns null for unknown id", async () => {
    const store = new MemoryTaskStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("get returns a defensive copy", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord());
    const a = await store.get("t1");
    const b = await store.get("t1");
    expect(a).not.toBe(b);
  });

  it("update merges patch", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord());
    await store.update("t1", { state: "completed", summary: "done" });
    const rec = await store.get("t1");
    expect(rec?.state).toBe("completed");
    expect(rec?.summary).toBe("done");
    expect(rec?.description).toBe("test task"); // untouched
  });

  it("update on unknown id is a no-op", async () => {
    const store = new MemoryTaskStore();
    await store.update("nope", { state: "failed" }); // should not throw
  });

  it("list with no filter returns all", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord({ taskId: "a", state: "running" }));
    await store.create(makeRecord({ taskId: "b", state: "completed" }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("list filters by state", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord({ taskId: "a", state: "running" }));
    await store.create(makeRecord({ taskId: "b", state: "completed" }));
    const running = await store.list({ state: "running" });
    expect(running).toHaveLength(1);
    expect(running[0].taskId).toBe("a");
  });

  it("list filters by delivered", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord({ taskId: "a", delivered: false }));
    await store.create(makeRecord({ taskId: "b", delivered: true }));
    const undelivered = await store.list({ delivered: false });
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0].taskId).toBe("a");
  });

  it("claim transitions queued → running", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord({ state: "queued" }));
    const claimed = await store.claim("t1", "worker-1");
    expect(claimed).toBe(true);
    const rec = await store.get("t1");
    expect(rec?.state).toBe("running");
    expect(rec?.workerId).toBe("worker-1");
  });

  it("claim returns false if not queued", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord({ state: "running" }));
    expect(await store.claim("t1", "w")).toBe(false);
  });

  it("claim returns false for unknown id", async () => {
    const store = new MemoryTaskStore();
    expect(await store.claim("nope", "w")).toBe(false);
  });

  it("claimResults returns completed/failed/cancelled undelivered records", async () => {
    const store = new MemoryTaskStore();
    await store.create(makeRecord({ taskId: "a", state: "completed", delivered: false }));
    await store.create(makeRecord({ taskId: "b", state: "failed", delivered: false }));
    await store.create(makeRecord({ taskId: "c", state: "cancelled", delivered: false }));
    await store.create(makeRecord({ taskId: "d", state: "running", delivered: false }));
    await store.create(makeRecord({ taskId: "e", state: "completed", delivered: true }));

    const results = await store.claimResults();
    const ids = results.map((r) => r.taskId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
