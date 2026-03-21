import { describe, it, expect } from "vitest";
import { executeTool } from "../tool-executor.js";
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
});
