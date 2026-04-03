import { describe, it, expect } from "vitest";
import { compactHistoryWithMemory } from "../context.js";
import { MockShell } from "./fixtures/mock-shell.js";
import type { ChatMessage } from "../types.js";

/** Create a message with enough content to consume measurable tokens. */
const makeMsg = (
  content: string,
  role: "user" | "assistant" = "user",
): ChatMessage => ({
  ts: "1",
  role,
  content,
});

/** Generate a history large enough to force trimming at a small token budget. */
function buildLargeHistory(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMsg("x".repeat(200), i % 2 === 0 ? "user" : "assistant"),
  );
}

describe("compactHistoryWithMemory", () => {
  it("returns no sessionMemory when nothing is trimmed", async () => {
    const history = [makeMsg("hi"), makeMsg("hello", "assistant")];
    const result = await compactHistoryWithMemory(history, 100_000);

    expect(result.trimmedCount).toBe(0);
    expect(result.sessionMemory).toBeUndefined();
    expect(result.kept).toHaveLength(2);
  });

  it("returns no sessionMemory when trimming without sessionMemoryPath", async () => {
    const history = buildLargeHistory(20);
    const result = await compactHistoryWithMemory(history, 100);

    expect(result.trimmedCount).toBeGreaterThan(0);
    expect(result.sessionMemory).toBeUndefined();
  });

  it("returns no sessionMemory when file does not exist", async () => {
    const shell = new MockShell();
    const history = buildLargeHistory(20);

    const result = await compactHistoryWithMemory(history, 100, {
      sessionMemoryPath: "/memory/session-memory.md",
      shell,
    });

    expect(result.trimmedCount).toBeGreaterThan(0);
    expect(result.sessionMemory).toBeUndefined();
  });

  it("returns sessionMemory when file exists and messages are trimmed", async () => {
    const shell = new MockShell();
    shell.files.set(
      "/memory/session-memory.md",
      "# Session Memory\n\n- User prefers concise answers",
    );

    const history = buildLargeHistory(20);

    const result = await compactHistoryWithMemory(history, 100, {
      sessionMemoryPath: "/memory/session-memory.md",
      shell,
    });

    expect(result.trimmedCount).toBeGreaterThan(0);
    expect(result.sessionMemory).toBe(
      "# Session Memory\n\n- User prefers concise answers",
    );
    expect(result.kept.length).toBeLessThan(history.length);
  });

  it("returns no sessionMemory when file is empty", async () => {
    const shell = new MockShell();
    shell.files.set("/memory/session-memory.md", "   ");

    const history = buildLargeHistory(20);

    const result = await compactHistoryWithMemory(history, 100, {
      sessionMemoryPath: "/memory/session-memory.md",
      shell,
    });

    expect(result.trimmedCount).toBeGreaterThan(0);
    expect(result.sessionMemory).toBeUndefined();
  });
});
