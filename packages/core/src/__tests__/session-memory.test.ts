import { describe, it, expect, beforeEach } from "vitest";
import {
  extractSessionMemory,
  buildExtractionPrompt,
} from "../session-memory.js";
import { ChatSession } from "../chat-session.js";
import { MockShell } from "./fixtures/mock-shell.js";
import { MockLLM } from "./fixtures/mock-llm.js";
import type { ChatMessage } from "../types.js";

describe("buildExtractionPrompt", () => {
  it("includes messages in prompt", () => {
    const messages: ChatMessage[] = [
      { ts: "1", role: "user", content: "hello world" },
      { ts: "2", role: "assistant", content: "hi there" },
    ];
    const result = buildExtractionPrompt(messages);
    expect(result).toContain("[user] hello world");
    expect(result).toContain("[assistant] hi there");
    expect(result).toContain("Session Memory");
  });

  it("includes existing memory when provided", () => {
    const messages: ChatMessage[] = [
      { ts: "1", role: "user", content: "test" },
    ];
    const result = buildExtractionPrompt(messages, "# Old Memory\nSome facts");
    expect(result).toContain("## Existing Memory");
    expect(result).toContain("# Old Memory");
  });

  it("caps message content at 500 chars", () => {
    const longContent = "x".repeat(1000);
    const messages: ChatMessage[] = [
      { ts: "1", role: "user", content: longContent },
    ];
    const result = buildExtractionPrompt(messages);
    // The prompt should contain at most 500 chars of the message content
    const match = result.match(/\[user\] (x+)/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBe(500);
  });
});

describe("extractSessionMemory", () => {
  let shell: MockShell;
  let llm: MockLLM;
  let session: ChatSession;
  const memoryRoot = "/mem";

  beforeEach(() => {
    shell = new MockShell();
    llm = new MockLLM();
    session = new ChatSession("/sessions/mouth.jsonl", shell);
  });

  function makeAssistantWithToolCalls(): ChatMessage {
    return {
      ts: new Date().toISOString(),
      role: "assistant",
      content: "calling tool",
      meta: { tool_calls: [{ id: "t1", name: "read_file", arguments: {} }] },
    };
  }

  function makeUserMessage(content = "user msg"): ChatMessage {
    return { ts: new Date().toISOString(), role: "user", content };
  }

  async function seedMessages(count: number, toolCallCount: number) {
    for (let i = 0; i < count; i++) {
      if (i < toolCallCount) {
        await session.append(makeAssistantWithToolCalls());
      } else {
        await session.append(makeUserMessage(`msg ${i}`));
      }
    }
  }

  it("returns null when below message threshold", async () => {
    // Only 5 messages, threshold is 20
    await seedMessages(5, 3);

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 0,
    });

    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it("returns null when below tool call threshold", async () => {
    // 25 messages but only 1 tool call (threshold is 3)
    await seedMessages(25, 1);

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 0,
    });

    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it("calls LLM and writes files when thresholds met", async () => {
    // 25 messages with 5 tool calls
    await seedMessages(25, 5);

    llm.addTextResponse("# Session Memory\n## Current State\nWorking on tests.");

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.newCheckpoint).toBe(25);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].model).toBe("test-model");

    // Verify session-memory.md was written
    const memoryContent = shell.files.get("/mem/session-memory.md");
    expect(memoryContent).toContain("Session Memory");

    // Verify checkpoint was written
    const checkpoint = shell.files.get("/mem/.session-memory-checkpoint");
    expect(checkpoint).toBe("25");
  });

  it("includes existing session-memory.md in prompt", async () => {
    await seedMessages(25, 5);
    shell.files.set("/mem/session-memory.md", "# Existing\nOld data here");

    llm.addTextResponse("# Session Memory\n## Current State\nUpdated.");

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 0,
    });

    expect(result).not.toBeNull();
    expect(llm.calls).toHaveLength(1);
    expect(shell.files.get("/mem/session-memory.md")).toBe(
      "# Session Memory\n## Current State\nUpdated.",
    );
  });

  it("returns null and does not write when LLM returns empty", async () => {
    await seedMessages(25, 5);

    llm.addTextResponse("   "); // whitespace-only

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 0,
    });

    expect(result).toBeNull();
    expect(shell.files.has("/mem/session-memory.md")).toBe(false);
    expect(shell.files.has("/mem/.session-memory-checkpoint")).toBe(false);
  });

  it("checkpoint value matches total message count", async () => {
    for (let i = 0; i < 5; i++) {
      await session.append(makeUserMessage(`early msg ${i}`));
    }
    for (let i = 0; i < 5; i++) {
      await session.append(makeAssistantWithToolCalls());
    }
    for (let i = 0; i < 20; i++) {
      await session.append(makeUserMessage(`late msg ${i}`));
    }

    llm.addTextResponse("# Session Memory\nExtracted.");

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.newCheckpoint).toBe(30);
    expect(shell.files.get("/mem/.session-memory-checkpoint")).toBe("30");
  });

  it("respects custom thresholds", async () => {
    await seedMessages(10, 2);

    llm.addTextResponse("# Session Memory\nCustom threshold met.");

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 0,
      config: { messageThreshold: 5, toolCallThreshold: 1 },
    });

    expect(result).not.toBeNull();
    expect(result!.newCheckpoint).toBe(10);
  });

  it("only considers messages after lastCheckpoint", async () => {
    // 30 total messages, but checkpoint is at 25 — only 5 new (below threshold)
    await seedMessages(30, 10);

    const result = await extractSessionMemory({
      session,
      llm,
      model: "test-model",
      shell,
      memoryRoot,
      lastCheckpoint: 25,
    });

    expect(result).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});
