import { describe, it, expect, vi } from "vitest";
import { LocalRuntime } from "../runtimes/local.js";
import { MemoryTaskStore } from "../stores/memory-task-store.js";
import type { HandExecutor, ExecutionContext } from "../runtime.js";
import type { TaskDispatch, TaskResult } from "../types.js";
import type { Shell } from "../providers/shell.js";

/** Minimal Shell stub — only writeFile is used by resume(). */
function stubShell(): Shell {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn().mockResolvedValue([]),
  };
}

function makeTask(id = "task-1"): TaskDispatch {
  return {
    taskId: id,
    description: "do something",
    sourceChat: "mouth.jsonl",
    replyTo: "telegram:123",
  };
}

/** Executor that resolves immediately with a given result. */
function immediateExecutor(
  result: Pick<TaskResult, "status" | "summary" | "error"> = {
    status: "completed",
    summary: "done",
  },
): HandExecutor {
  return {
    name: "test",
    execute: vi.fn().mockImplementation(async (task: TaskDispatch) => ({
      taskId: task.taskId,
      ...result,
    })),
  };
}

/** Executor that hangs until abort or manual resolve. */
function hangingExecutor(): {
  executor: HandExecutor;
  resolve: (r: TaskResult) => void;
} {
  let resolveFn!: (r: TaskResult) => void;
  const executor: HandExecutor = {
    name: "hanging",
    execute: vi.fn().mockImplementation(
      () => new Promise<TaskResult>((res) => { resolveFn = res; }),
    ),
  };
  return { executor, resolve: (r) => resolveFn(r) };
}

/** Wait for microtasks / promises to flush. */
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("LocalRuntime", () => {
  it("submit runs executor and delivers result", async () => {
    const store = new MemoryTaskStore();
    const executor = immediateExecutor();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: TaskResult[] = [];
    runtime.onComplete(async (r) => { delivered.push(r); });
    await runtime.start();

    await runtime.submit(makeTask());
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe("completed");
    expect(delivered[0].summary).toBe("done");

    const rec = await store.get("task-1");
    expect(rec?.state).toBe("completed");
    expect(rec?.delivered).toBe(true);
  });

  it("submit stores task as running before executor starts", async () => {
    const { executor } = hangingExecutor();
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });
    await runtime.start();

    await runtime.submit(makeTask());
    // Executor is still pending — store should show running
    const rec = await store.get("task-1");
    expect(rec?.state).toBe("running");

    await runtime.stop();
  });

  it("cancel sets state to cancelled", async () => {
    const { executor, resolve } = hangingExecutor();
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: TaskResult[] = [];
    runtime.onComplete(async (r) => { delivered.push(r); });
    await runtime.start();

    await runtime.submit(makeTask());
    await runtime.cancel("task-1");

    const rec = await store.get("task-1");
    expect(rec?.state).toBe("cancelled");

    // Executor finishes after cancel — should deliver cancelled, not completed
    resolve({ taskId: "task-1", status: "completed", summary: "late" });
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe("cancelled");
  });

  it("cancel on non-existent task is a no-op", async () => {
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, immediateExecutor(), {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });
    await runtime.start();
    await runtime.cancel("nope"); // should not throw
  });

  it("status returns task status", async () => {
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, immediateExecutor(), {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });
    await runtime.start();

    await runtime.submit(makeTask());
    await flush();

    const s = await runtime.status("task-1");
    expect(s?.state).toBe("completed");
    expect(s?.description).toBe("do something");
  });

  it("status returns null for unknown task", async () => {
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, immediateExecutor(), {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });
    await runtime.start();
    expect(await runtime.status("nope")).toBeNull();
  });

  it("list returns only running tasks", async () => {
    const { executor } = hangingExecutor();
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });
    await runtime.start();

    await runtime.submit(makeTask("a"));
    const tasks = await runtime.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("a");

    await runtime.stop();
  });

  it("executor failure produces failed result", async () => {
    const executor = immediateExecutor({
      status: "failed",
      summary: "",
      error: "boom",
    });
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: TaskResult[] = [];
    runtime.onComplete(async (r) => { delivered.push(r); });
    await runtime.start();

    await runtime.submit(makeTask());
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe("failed");
    expect(delivered[0].error).toBe("boom");
  });

  it("executor throwing produces failed result", async () => {
    const executor: HandExecutor = {
      name: "throw",
      execute: vi.fn().mockRejectedValue(new Error("kaboom")),
    };
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: TaskResult[] = [];
    runtime.onComplete(async (r) => { delivered.push(r); });
    await runtime.start();

    await runtime.submit(makeTask());
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].status).toBe("failed");
    expect(delivered[0].error).toBe("kaboom");
  });

  it("start() recovers stale running tasks as failed", async () => {
    const store = new MemoryTaskStore();
    // Pre-populate a stale running task (simulates crash)
    await store.create({
      taskId: "stale-1",
      description: "was running",
      sourceChat: "mouth.jsonl",
      executor: "builtin",
      state: "running",
      delivered: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const runtime = new LocalRuntime(store, immediateExecutor(), {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: TaskResult[] = [];
    runtime.onComplete(async (r) => { delivered.push(r); });

    await runtime.start();

    // Stale task should be marked failed
    const rec = await store.get("stale-1");
    expect(rec?.state).toBe("failed");
    expect(rec?.error).toContain("interrupted");
  });

  it("start() delivers undelivered completed results", async () => {
    const store = new MemoryTaskStore();
    // Pre-populate a completed but undelivered task
    await store.create({
      taskId: "done-1",
      description: "completed before crash",
      sourceChat: "mouth.jsonl",
      executor: "builtin",
      state: "completed",
      summary: "result from before",
      delivered: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      replyTo: "telegram:456",
    });

    const runtime = new LocalRuntime(store, immediateExecutor(), {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: TaskResult[] = [];
    runtime.onComplete(async (r) => { delivered.push(r); });

    await runtime.start();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].taskId).toBe("done-1");
    expect(delivered[0].status).toBe("completed");

    const rec = await store.get("done-1");
    expect(rec?.delivered).toBe(true);
  });

  it("onProgress updates currentTurn in store", async () => {
    let capturedCtx!: ExecutionContext;
    const executor: HandExecutor = {
      name: "progress",
      execute: vi.fn().mockImplementation(async (task: TaskDispatch, ctx: ExecutionContext) => {
        capturedCtx = ctx;
        ctx.onProgress({ currentTurn: 1 });
        ctx.onProgress({ currentTurn: 2 });
        // Wait for async updates
        await flush();
        return { taskId: task.taskId, status: "completed" as const, summary: "ok" };
      }),
    };
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, executor, {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });
    await runtime.start();

    await runtime.submit(makeTask());
    await flush();

    const rec = await store.get("task-1");
    expect(rec?.currentTurn).toBe(2);
  });

  it("replyTo is passed through to onComplete callback", async () => {
    const store = new MemoryTaskStore();
    const runtime = new LocalRuntime(store, immediateExecutor(), {
      shell: stubShell(),
      sessionsDir: "/sessions",
    });

    const delivered: Array<TaskResult & { replyTo?: string }> = [];
    runtime.onComplete(async (r) => { delivered.push(r); });
    await runtime.start();

    await runtime.submit(makeTask());
    await flush();

    expect(delivered[0].replyTo).toBe("telegram:123");
  });
});
