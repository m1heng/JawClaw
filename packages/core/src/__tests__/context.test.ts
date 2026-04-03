import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  compactHistory,
  snipOldMessages,
  collapseFailedGroups,
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

// ── Helpers for snip & collapse tests ────────────────────────────

function toolGroup(
  toolName: string,
  result: string,
  ts = "1",
): ChatMessage[] {
  return [
    {
      ts,
      role: "assistant",
      content: "",
      meta: { tool_calls: [{ id: `tc_${ts}`, name: toolName, arguments: {} }] },
    },
    {
      ts,
      role: "tool",
      content: result,
      meta: { tool_call_id: `tc_${ts}`, tool_name: toolName },
    },
  ];
}

describe("snipOldMessages", () => {
  it("returns unchanged when under threshold", () => {
    const msgs: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      ts: String(i),
      role: "user" as const,
      content: `msg ${i}`,
    }));
    expect(snipOldMessages(msgs, 100)).toEqual(msgs);
  });

  it("drops oldest units when over threshold", () => {
    // 250 simple messages, threshold 200 → keep ~80% of units
    const msgs: ChatMessage[] = Array.from({ length: 250 }, (_, i) => ({
      ts: String(i),
      role: "user" as const,
      content: `msg ${i}`,
    }));
    const result = snipOldMessages(msgs, 200);
    expect(result.length).toBeLessThan(250);
    expect(result.length).toBeGreaterThan(150);
    // Last message should be preserved
    expect(result[result.length - 1].content).toBe("msg 249");
  });

  it("keeps tool-call groups atomic", () => {
    const msgs: ChatMessage[] = [
      ...Array.from({ length: 80 }, (_, i) => ({
        ts: String(i),
        role: "user" as const,
        content: `msg ${i}`,
      })),
      ...toolGroup("read_file", "file content", "90"),
      ...Array.from({ length: 30 }, (_, i) => ({
        ts: String(100 + i),
        role: "user" as const,
        content: `msg ${100 + i}`,
      })),
    ];
    const result = snipOldMessages(msgs, 100);
    // If the tool group is kept, both assistant and tool should be present
    const hasAssistant = result.some((m) => m.role === "assistant" && m.meta?.tool_calls);
    const hasTool = result.some((m) => m.role === "tool");
    if (hasAssistant) expect(hasTool).toBe(true);
    if (hasTool) expect(hasAssistant).toBe(true);
  });
});

describe("collapseFailedGroups", () => {
  it("returns unchanged when no failed groups", () => {
    const msgs: ChatMessage[] = [
      { ts: "1", role: "user", content: "hello" },
      ...toolGroup("read_file", "file contents", "2"),
    ];
    const result = collapseFailedGroups(msgs);
    expect(result).toEqual(msgs);
  });

  it("does not collapse fewer than 3 consecutive failed groups", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
    ];
    const result = collapseFailedGroups(msgs);
    expect(result).toEqual(msgs);
  });

  it("collapses 3+ consecutive failed groups", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "Error: something", "2"),
      ...toolGroup("glob", "(no files found)", "3"),
    ];
    const result = collapseFailedGroups(msgs);
    // Should be collapsed into 1 message
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("3 tool-call groups collapsed");
    expect(result[0].content).toContain("grep");
    expect(result[0].content).toContain("glob");
  });

  it("preserves success groups around collapsed failures", () => {
    const msgs: ChatMessage[] = [
      { ts: "0", role: "user", content: "start" },
      ...toolGroup("read_file", "success content", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
      ...toolGroup("grep", "(no matches)", "3"),
      ...toolGroup("grep", "(no matches)", "4"),
      ...toolGroup("read_file", "more success", "5"),
    ];
    const result = collapseFailedGroups(msgs);
    // user + success group(2) + collapsed(1) + success group(2) = 6
    expect(result).toHaveLength(6);
    expect(result[0].content).toBe("start");
    expect(result[1].content).toBe("");  // assistant with tool_calls
    expect(result[2].content).toBe("success content");
    expect(result[3].content).toContain("3 tool-call groups collapsed");
    expect(result[4].content).toBe(""); // assistant
    expect(result[5].content).toBe("more success");
  });

  it("does not collapse empty-result groups (silent success)", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("run_command", "", "1"),
      ...toolGroup("run_command", "", "2"),
      ...toolGroup("run_command", "", "3"),
    ];
    const result = collapseFailedGroups(msgs);
    // Empty results are silent successes (mkdir, touch, git add), NOT failures
    expect(result).toEqual(msgs);
  });

  it("detects all failure patterns", () => {
    const patterns = ["(no matches)", "(no files found)", "Error: bad", "exit code 1\nstderr: fail"];
    for (const pattern of patterns) {
      const msgs: ChatMessage[] = [
        ...toolGroup("test", pattern, "1"),
        ...toolGroup("test", pattern, "2"),
        ...toolGroup("test", pattern, "3"),
      ];
      const result = collapseFailedGroups(msgs);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain("collapsed");
    }
  });

  it("does not collapse non-tool-call messages", () => {
    const msgs: ChatMessage[] = [
      { ts: "1", role: "user", content: "" },
      { ts: "2", role: "user", content: "" },
      { ts: "3", role: "user", content: "" },
    ];
    const result = collapseFailedGroups(msgs);
    expect(result).toEqual(msgs);
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
