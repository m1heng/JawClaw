import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  compactHistory,
  snipOldMessages,
  collapseFailedGroups,
  watermarkToMessageIndex,
  buildSystemPrompt,
  mouthBootstrapFiles,
  mouthStableBootstrapFiles,
  mouthDynamicBootstrapFiles,
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
    const { messages } = collapseFailedGroups(msgs);
    expect(messages).toEqual(msgs);
  });

  it("does not collapse fewer than 3 consecutive failed groups", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
    ];
    const { messages } = collapseFailedGroups(msgs);
    expect(messages).toEqual(msgs);
  });

  it("collapses 3+ consecutive failed groups", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "Error: something", "2"),
      ...toolGroup("glob", "(no files found)", "3"),
    ];
    const { messages } = collapseFailedGroups(msgs);
    // Should be collapsed into 1 message
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("3 tool-call groups collapsed");
    expect(messages[0].content).toContain("grep");
    expect(messages[0].content).toContain("glob");
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
    const { messages } = collapseFailedGroups(msgs);
    // user + success group(2) + collapsed(1) + success group(2) = 6
    expect(messages).toHaveLength(6);
    expect(messages[0].content).toBe("start");
    expect(messages[1].content).toBe("");  // assistant with tool_calls
    expect(messages[2].content).toBe("success content");
    expect(messages[3].content).toContain("3 tool-call groups collapsed");
    expect(messages[4].content).toBe(""); // assistant
    expect(messages[5].content).toBe("more success");
  });

  it("does not collapse empty-result groups (silent success)", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("run_command", "", "1"),
      ...toolGroup("run_command", "", "2"),
      ...toolGroup("run_command", "", "3"),
    ];
    const { messages } = collapseFailedGroups(msgs);
    // Empty results are silent successes (mkdir, touch, git add), NOT failures
    expect(messages).toEqual(msgs);
  });

  it("detects all failure patterns", () => {
    const patterns = ["(no matches)", "(no files found)", "Error: bad", "exit code 1\nstderr: fail"];
    for (const pattern of patterns) {
      const msgs: ChatMessage[] = [
        ...toolGroup("test", pattern, "1"),
        ...toolGroup("test", pattern, "2"),
        ...toolGroup("test", pattern, "3"),
      ];
      const { messages } = collapseFailedGroups(msgs);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("collapsed");
    }
  });

  it("does not collapse non-tool-call messages", () => {
    const msgs: ChatMessage[] = [
      { ts: "1", role: "user", content: "" },
      { ts: "2", role: "user", content: "" },
      { ts: "3", role: "user", content: "" },
    ];
    const { messages } = collapseFailedGroups(msgs);
    expect(messages).toEqual(msgs);
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

describe("collapseFailedGroups with boundaryIndex", () => {
  it("does not collapse failed groups past the boundary", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
      ...toolGroup("grep", "(no matches)", "3"),
      ...toolGroup("grep", "(no matches)", "4"),
    ];
    // Boundary at message index 4 (after group 1)
    const { messages } = collapseFailedGroups(msgs, { boundaryIndex: 4 });
    // Groups before boundary: only 2 failures → not collapsed
    // Groups after boundary: untouched
    expect(messages).toEqual(msgs);
  });

  it("collapses only within the truncated zone", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
      ...toolGroup("grep", "(no matches)", "3"),
      // boundary here (message index 6)
      ...toolGroup("grep", "(no matches)", "4"),
      ...toolGroup("grep", "(no matches)", "5"),
      ...toolGroup("grep", "(no matches)", "6"),
    ];
    const { messages } = collapseFailedGroups(msgs, { boundaryIndex: 6 });
    // Before boundary: 3 failed groups → collapsed into 1
    // After boundary: 3 failed groups → NOT collapsed (past boundary)
    expect(messages.length).toBe(1 + 6);
    expect(messages[0].content).toContain("3 tool-call groups collapsed");
    expect(messages[1].role).toBe("assistant");
  });

  it("boundary at 0 prevents all collapsing", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
      ...toolGroup("grep", "(no matches)", "3"),
    ];
    const { messages } = collapseFailedGroups(msgs, { boundaryIndex: 0 });
    expect(messages).toEqual(msgs);
  });

  it("undefined boundary behaves like original (collapse everything)", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
      ...toolGroup("grep", "(no matches)", "3"),
    ];
    const { messages } = collapseFailedGroups(msgs);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("collapsed");
  });

  it("processedCount freezes already-collapsed messages", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("grep", "(no matches)", "1"),
      ...toolGroup("grep", "(no matches)", "2"),
      // On first call, only 2 failed groups — not collapsed
    ];
    const r1 = collapseFailedGroups(msgs);
    expect(r1.messages).toEqual(msgs);

    // A 3rd failed group arrives — but previous messages are frozen
    const msgs2: ChatMessage[] = [
      ...msgs,
      ...toolGroup("grep", "(no matches)", "3"),
    ];
    const r2 = collapseFailedGroups(msgs2, { processedCount: r1.processedCount });
    // First 4 messages (groups 1-2) frozen, only group 3 is new (1 failure, not collapsed)
    expect(r2.messages).toEqual(msgs2);
  });
});

describe("watermarkToMessageIndex", () => {
  it("returns 0 when watermark is 0", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("read_file", "content", "1"),
      { ts: "2", role: "user", content: "hello" },
    ];
    expect(watermarkToMessageIndex(msgs, 0)).toBe(0);
  });

  it("maps watermark to correct message index", () => {
    const msgs: ChatMessage[] = [
      { ts: "0", role: "user", content: "q1" },     // idx 0
      ...toolGroup("read_file", "content", "1"),      // idx 1-2 (group 0)
      { ts: "3", role: "user", content: "q2" },      // idx 3
      ...toolGroup("grep", "matches", "4"),           // idx 4-5 (group 1)
      ...toolGroup("glob", "files", "6"),             // idx 6-7 (group 2)
    ];
    // watermark=1 → after group 0 → message index 3
    expect(watermarkToMessageIndex(msgs, 1)).toBe(3);
    // watermark=2 → after group 1 → message index 6
    expect(watermarkToMessageIndex(msgs, 2)).toBe(6);
    // watermark=3 → after group 2 → message index 8
    expect(watermarkToMessageIndex(msgs, 3)).toBe(8);
  });

  it("returns total message count when watermark exceeds groups", () => {
    const msgs: ChatMessage[] = [
      ...toolGroup("read_file", "content", "1"),
    ];
    expect(watermarkToMessageIndex(msgs, 5)).toBe(2);
  });
});

describe("bootstrapFiles", () => {
  it("mouthBootstrapFiles returns SOUL + INSTRUCTIONS + MEMORY (deprecated compat)", () => {
    const files = mouthBootstrapFiles("/ws/memory");
    const labels = files.map((f) => f.label);
    expect(labels).toContain("SOUL.md");
    expect(labels).toContain("INSTRUCTIONS.md");
    expect(labels).toContain("MEMORY.md");
    expect(labels).toContain("Session Memory");
  });

  it("mouthStableBootstrapFiles returns SOUL + INSTRUCTIONS only", () => {
    const files = mouthStableBootstrapFiles("/ws/memory");
    const labels = files.map((f) => f.label);
    expect(labels).toEqual(["SOUL.md", "INSTRUCTIONS.md"]);
  });

  it("mouthDynamicBootstrapFiles returns MEMORY + Session Memory only", () => {
    const files = mouthDynamicBootstrapFiles("/ws/memory");
    const labels = files.map((f) => f.label);
    expect(labels).toEqual(["MEMORY.md", "Session Memory"]);
  });

  it("handBootstrapFiles returns SOUL + INSTRUCTIONS only", () => {
    const files = handBootstrapFiles("/ws/memory");
    const labels = files.map((f) => f.label);
    expect(labels).toContain("SOUL.md");
    expect(labels).toContain("INSTRUCTIONS.md");
    expect(labels).not.toContain("MEMORY.md");
  });
});
