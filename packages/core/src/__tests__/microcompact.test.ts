import { describe, it, expect } from "vitest";
import { microcompactToolResults } from "../microcompact.js";
import type { ChatMessage } from "../types.js";

/** Helper to create a simple user or assistant message. */
function makeMsg(
  content: string,
  role: "user" | "assistant" = "user",
): ChatMessage {
  return { ts: "1", role, content };
}

/** Helper to create a tool-call group (assistant + N tool results). */
function makeToolGroup(
  toolContent: string,
  toolCount = 1,
): ChatMessage[] {
  const assistant: ChatMessage = {
    ts: "1",
    role: "assistant",
    content: "",
    meta: {
      tool_calls: Array.from({ length: toolCount }, (_, i) => ({
        id: `t${i}`,
        name: "read_file",
        arguments: { path: "x" },
      })),
    },
  };
  const tools: ChatMessage[] = Array.from({ length: toolCount }, (_, i) => ({
    ts: "1",
    role: "tool" as const,
    content: toolContent,
    meta: { tool_call_id: `t${i}`, tool_name: "read_file" },
  }));
  return [assistant, ...tools];
}

describe("microcompactToolResults", () => {
  it("returns messages unchanged when there are no tool-call groups", () => {
    const msgs = [makeMsg("hello"), makeMsg("world", "assistant")];
    const result = microcompactToolResults(msgs);
    expect(result).toEqual(msgs);
  });

  it("returns messages unchanged when tool-call groups <= keepRecentGroups", () => {
    const bigContent = "x".repeat(5000);
    const msgs: ChatMessage[] = [
      makeMsg("q1"),
      ...makeToolGroup(bigContent),
      makeMsg("q2"),
      ...makeToolGroup(bigContent),
      makeMsg("q3"),
      ...makeToolGroup(bigContent),
    ];
    const result = microcompactToolResults(msgs, { keepRecentGroups: 3 });
    expect(result).toEqual(msgs);
  });

  it("truncates older tool results when groups > keepRecentGroups", () => {
    const bigContent = "x".repeat(5000);
    const msgs: ChatMessage[] = [
      makeMsg("q1"),
      ...makeToolGroup(bigContent),
      makeMsg("q2"),
      ...makeToolGroup(bigContent),
      makeMsg("q3"),
      ...makeToolGroup(bigContent),
      makeMsg("q4"),
      ...makeToolGroup(bigContent),
    ];
    const result = microcompactToolResults(msgs, {
      keepRecentGroups: 2,
      maxCharsPerResult: 1500,
      headChars: 100,
      tailChars: 50,
    });

    // The last 2 tool groups should be intact
    // Find all tool messages
    const toolMsgs = result.filter((m) => m.role === "tool");
    // Last 2 tool results should be original length
    expect(toolMsgs[toolMsgs.length - 1].content).toBe(bigContent);
    expect(toolMsgs[toolMsgs.length - 2].content).toBe(bigContent);
    // First 2 tool results should be truncated
    expect(toolMsgs[0].content).toContain("[...");
    expect(toolMsgs[0].content).toContain("chars omitted");
    expect(toolMsgs[0].content.length).toBeLessThan(bigContent.length);
    expect(toolMsgs[1].content).toContain("[...");
  });

  it("does not truncate small tool results in old groups", () => {
    const smallContent = "short result";
    const bigContent = "x".repeat(5000);
    const msgs: ChatMessage[] = [
      makeMsg("q1"),
      ...makeToolGroup(smallContent), // old group, but small content
      makeMsg("q2"),
      ...makeToolGroup(bigContent),
      makeMsg("q3"),
      ...makeToolGroup(bigContent),
    ];
    const result = microcompactToolResults(msgs, {
      keepRecentGroups: 1,
      maxCharsPerResult: 1500,
    });

    const toolMsgs = result.filter((m) => m.role === "tool");
    // The first tool result is small, should not be truncated
    expect(toolMsgs[0].content).toBe(smallContent);
    // The second is big and old, should be truncated
    expect(toolMsgs[1].content).toContain("[...");
    // The last is recent, should be intact
    expect(toolMsgs[2].content).toBe(bigContent);
  });

  it("does not modify non-tool messages in truncated groups", () => {
    const bigContent = "x".repeat(5000);
    const msgs: ChatMessage[] = [
      makeMsg("q1"),
      ...makeToolGroup(bigContent),
      makeMsg("q2"),
      ...makeToolGroup(bigContent),
    ];
    const result = microcompactToolResults(msgs, { keepRecentGroups: 1 });

    // User messages should be untouched
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs[0].content).toBe("q1");
    expect(userMsgs[1].content).toBe("q2");

    // Assistant messages in the old tool group should be untouched
    const assistantMsgs = result.filter(
      (m) => m.role === "assistant" && m.meta?.tool_calls,
    );
    expect(assistantMsgs[0].content).toBe("");
    expect(assistantMsgs[0].meta?.tool_calls).toBeDefined();
  });

  it("does not mutate the original array", () => {
    const bigContent = "x".repeat(5000);
    const msgs: ChatMessage[] = [
      makeMsg("q1"),
      ...makeToolGroup(bigContent),
      makeMsg("q2"),
      ...makeToolGroup(bigContent),
    ];
    const originalContents = msgs.map((m) => m.content);
    microcompactToolResults(msgs, { keepRecentGroups: 1 });
    // Original messages should be unchanged
    msgs.forEach((m, i) => {
      expect(m.content).toBe(originalContents[i]);
    });
  });

  it("uses default options when none provided", () => {
    const bigContent = "x".repeat(5000);
    // 4 tool groups — default keepRecentGroups=3, so only the oldest gets truncated
    const msgs: ChatMessage[] = [
      ...makeToolGroup(bigContent),
      ...makeToolGroup(bigContent),
      ...makeToolGroup(bigContent),
      ...makeToolGroup(bigContent),
    ];
    const result = microcompactToolResults(msgs);

    const toolMsgs = result.filter((m) => m.role === "tool");
    // First tool result (oldest group) should be truncated
    expect(toolMsgs[0].content).toContain("[...");
    // Last 3 should be intact
    expect(toolMsgs[1].content).toBe(bigContent);
    expect(toolMsgs[2].content).toBe(bigContent);
    expect(toolMsgs[3].content).toBe(bigContent);
  });
});
