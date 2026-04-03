import { describe, it, expect } from "vitest";
import {
  executeTool,
  applyResultBudget,
  executeToolsConcurrently,
  CONCURRENT_SAFE_TOOLS,
} from "../tool-executor.js";
import type { ToolRegistry } from "../tool-executor.js";

describe("executeTool", () => {
  const registry: ToolRegistry = {
    greet: async (args) => `Hello, ${args.name}!`,
    fail: async () => {
      throw new Error("boom");
    },
  };

  it("calls the correct handler with arguments", async () => {
    const result = await executeTool(
      { id: "1", name: "greet", arguments: { name: "Alice" } },
      registry,
    );
    expect(result).toBe("Hello, Alice!");
  });

  it("returns error for unknown tool", async () => {
    const result = await executeTool(
      { id: "2", name: "unknown_tool", arguments: {} },
      registry,
    );
    expect(result).toContain("unknown tool");
  });

  it("catches handler exceptions and returns error string", async () => {
    const result = await executeTool(
      { id: "3", name: "fail", arguments: {} },
      registry,
    );
    expect(result).toContain("boom");
    expect(result).toContain("Error");
  });

  it("applies result budget to large outputs", async () => {
    const bigRegistry: ToolRegistry = {
      big: async () => "x".repeat(50_000),
    };
    const result = await executeTool(
      { id: "4", name: "big", arguments: {} },
      bigRegistry,
    );
    expect(result.length).toBeLessThan(50_000);
    expect(result).toContain("chars omitted (result budget)");
  });

  it("respects custom maxResultChars", async () => {
    const bigRegistry: ToolRegistry = {
      big: async () => "x".repeat(200),
    };
    const result = await executeTool(
      { id: "5", name: "big", arguments: {} },
      bigRegistry,
      100,
    );
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("chars omitted (result budget)");
  });
});

describe("applyResultBudget", () => {
  it("returns short results unchanged", () => {
    expect(applyResultBudget("short", 100)).toBe("short");
  });

  it("truncates with head+tail for long results", () => {
    const input = "A".repeat(100);
    const result = applyResultBudget(input, 50);
    // 70% head = 35, 20% tail = 10
    expect(result).toContain("A".repeat(35));
    expect(result).toContain("chars omitted (result budget)");
    expect(result.length).toBeLessThan(100);
  });

  it("preserves head and tail content", () => {
    const input = "HEAD" + "x".repeat(1000) + "TAIL";
    const result = applyResultBudget(input, 100);
    expect(result.startsWith("HEAD")).toBe(true);
    expect(result.endsWith("TAIL")).toBe(true);
  });
});

describe("CONCURRENT_SAFE_TOOLS", () => {
  it("contains read-only tools", () => {
    expect(CONCURRENT_SAFE_TOOLS.has("read_file")).toBe(true);
    expect(CONCURRENT_SAFE_TOOLS.has("grep")).toBe(true);
    expect(CONCURRENT_SAFE_TOOLS.has("glob")).toBe(true);
    expect(CONCURRENT_SAFE_TOOLS.has("memory_query")).toBe(true);
  });

  it("does not contain write/execute tools", () => {
    expect(CONCURRENT_SAFE_TOOLS.has("write_file")).toBe(false);
    expect(CONCURRENT_SAFE_TOOLS.has("run_command")).toBe(false);
    expect(CONCURRENT_SAFE_TOOLS.has("edit_file")).toBe(false);
  });
});

describe("executeToolsConcurrently", () => {
  it("returns empty array for empty calls", async () => {
    expect(await executeToolsConcurrently([], {})).toEqual([]);
  });

  it("executes all-read batch in parallel", async () => {
    const delays: number[] = [];
    const registry: ToolRegistry = {
      read_file: async (args) => {
        const delay = (args.delay as number) ?? 50;
        await new Promise((r) => setTimeout(r, delay));
        delays.push(delay);
        return `read:${args.path}`;
      },
    };

    const calls = [
      { id: "1", name: "read_file", arguments: { path: "a.txt", delay: 50 } },
      { id: "2", name: "read_file", arguments: { path: "b.txt", delay: 50 } },
      { id: "3", name: "read_file", arguments: { path: "c.txt", delay: 50 } },
    ];

    const start = Date.now();
    const results = await executeToolsConcurrently(calls, registry);
    const elapsed = Date.now() - start;

    // Parallel: ~50ms. Serial would be ~150ms.
    expect(elapsed).toBeLessThan(120);
    expect(results).toEqual(["read:a.txt", "read:b.txt", "read:c.txt"]);
  });

  it("falls back to serial when batch contains exclusive tool", async () => {
    const order: string[] = [];
    const registry: ToolRegistry = {
      read_file: async () => { order.push("read"); return "ok"; },
      write_file: async () => { order.push("write"); return "ok"; },
    };

    const calls = [
      { id: "1", name: "read_file", arguments: {} },
      { id: "2", name: "write_file", arguments: {} },
    ];

    const results = await executeToolsConcurrently(calls, registry);
    expect(results).toEqual(["ok", "ok"]);
    // Serial execution means order is deterministic
    expect(order).toEqual(["read", "write"]);
  });

  it("preserves result order matching call order", async () => {
    const registry: ToolRegistry = {
      read_file: async (args) => `result:${args.id}`,
    };

    const calls = [
      { id: "a", name: "read_file", arguments: { id: "first" } },
      { id: "b", name: "read_file", arguments: { id: "second" } },
    ];

    const results = await executeToolsConcurrently(calls, registry);
    expect(results).toEqual(["result:first", "result:second"]);
  });

  it("handles single tool call", async () => {
    const registry: ToolRegistry = {
      read_file: async () => "single",
    };
    const results = await executeToolsConcurrently(
      [{ id: "1", name: "read_file", arguments: {} }],
      registry,
    );
    expect(results).toEqual(["single"]);
  });

  it("returns error string for unknown tool in batch", async () => {
    const registry: ToolRegistry = {
      read_file: async () => "ok",
    };
    const results = await executeToolsConcurrently(
      [
        { id: "1", name: "read_file", arguments: {} },
        { id: "2", name: "glob", arguments: {} },
      ],
      registry,
    );
    expect(results[0]).toBe("ok");
    expect(results[1]).toContain("unknown tool");
  });
});
