import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  compactHistory,
  buildSystemPrompt,
  mouthBootstrapFiles,
  handBootstrapFiles,
} from "../context.js";
import { MockShell } from "./fixtures/mock-shell.js";
import type { ChatMessage } from "../types.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → ceil = 3
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("estimateMessageTokens", () => {
  it("includes content + overhead", () => {
    const msg: ChatMessage = { ts: "1", role: "user", content: "hello" };
    const tokens = estimateMessageTokens(msg);
    // 5 chars / 4 = 2 (ceil) + 4 overhead = 6
    expect(tokens).toBe(6);
  });

  it("includes meta in estimate", () => {
    const msg: ChatMessage = {
      ts: "1",
      role: "user",
      content: "hi",
      meta: { chat_id: "12345", sender_name: "Alice" },
    };
    const withMeta = estimateMessageTokens(msg);
    const withoutMeta = estimateMessageTokens({ ts: "1", role: "user", content: "hi" });
    expect(withMeta).toBeGreaterThan(withoutMeta);
  });
});

describe("compactHistory", () => {
  const makeMsg = (content: string, role: "user" | "assistant" = "user"): ChatMessage => ({
    ts: "1",
    role,
    content,
  });

  it("keeps all messages when under budget", () => {
    const history = [makeMsg("a"), makeMsg("b")];
    const { kept, trimmedCount } = compactHistory(history, 10000);
    expect(kept).toHaveLength(2);
    expect(trimmedCount).toBe(0);
  });

  it("trims old messages when over budget", () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      makeMsg("x".repeat(100), i % 2 === 0 ? "user" : "assistant"),
    );
    const { kept, trimmedCount } = compactHistory(history, 200);
    expect(trimmedCount).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(history.length);
  });

  it("always keeps at least the last message", () => {
    const history = [makeMsg("x".repeat(1000))];
    const { kept } = compactHistory(history, 10);
    expect(kept).toHaveLength(1);
  });

  it("keeps tool-call groups atomic", () => {
    const history: ChatMessage[] = [
      makeMsg("do something"),
      {
        ts: "2",
        role: "assistant",
        content: "",
        meta: {
          tool_calls: [{ id: "t1", name: "read_file", arguments: { path: "x" } }],
        },
      },
      { ts: "3", role: "tool", content: "file contents", meta: { tool_call_id: "t1" } },
      makeMsg("thanks", "assistant"),
    ];
    const { kept } = compactHistory(history, 10000);
    // tool-call group should stay together
    const hasAssistantWithToolCalls = kept.some(
      (m) => m.role === "assistant" && m.meta?.tool_calls,
    );
    const hasToolResult = kept.some((m) => m.role === "tool");
    if (hasAssistantWithToolCalls) {
      expect(hasToolResult).toBe(true);
    }
  });
});

describe("buildSystemPrompt", () => {
  it("appends bootstrap files to base prompt", async () => {
    const shell = new MockShell();
    shell.files.set("/ws/SOUL.md", "I am a helpful bot.");

    const result = await buildSystemPrompt(
      "Base prompt.",
      [{ label: "SOUL.md", path: "/ws/SOUL.md" }],
      shell,
    );

    expect(result).toContain("Base prompt.");
    expect(result).toContain("I am a helpful bot.");
    expect(result).toContain("## SOUL.md");
  });

  it("skips missing files", async () => {
    const shell = new MockShell();

    const result = await buildSystemPrompt(
      "Base.",
      [{ label: "MISSING.md", path: "/ws/MISSING.md" }],
      shell,
    );

    expect(result).toBe("Base.");
  });

  it("skips empty files", async () => {
    const shell = new MockShell();
    shell.files.set("/ws/EMPTY.md", "   ");

    const result = await buildSystemPrompt(
      "Base.",
      [{ label: "EMPTY.md", path: "/ws/EMPTY.md" }],
      shell,
    );

    expect(result).toBe("Base.");
  });

  it("truncates large files", async () => {
    const shell = new MockShell();
    shell.files.set("/ws/BIG.md", "x".repeat(20000));

    const result = await buildSystemPrompt(
      "Base.",
      [{ label: "BIG.md", path: "/ws/BIG.md" }],
      shell,
      { maxPerFile: 1000 },
    );

    expect(result.length).toBeLessThan(22000);
    expect(result).toContain("truncated");
  });
});

describe("bootstrapFiles", () => {
  it("mouthBootstrapFiles returns SOUL + INSTRUCTIONS + MEMORY", () => {
    const files = mouthBootstrapFiles("/ws/memory");
    const labels = files.map((f) => f.label);
    expect(labels).toContain("SOUL.md");
    expect(labels).toContain("INSTRUCTIONS.md");
    expect(labels).toContain("MEMORY.md");
    expect(labels).not.toContain("USER.md");
  });

  it("handBootstrapFiles returns SOUL + INSTRUCTIONS only", () => {
    const files = handBootstrapFiles("/ws/memory");
    const labels = files.map((f) => f.label);
    expect(labels).toContain("SOUL.md");
    expect(labels).toContain("INSTRUCTIONS.md");
    expect(labels).not.toContain("MEMORY.md");
  });
});
