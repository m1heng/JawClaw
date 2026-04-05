import { describe, it, expect, beforeEach } from "vitest";
import { runReactLoop } from "../react-loop.js";
import { ChatSession } from "../chat-session.js";
import { MessageQueue } from "../message-queue.js";
import { MockShell } from "./fixtures/mock-shell.js";
import { MockLLM } from "./fixtures/mock-llm.js";
import type { AgentConfig, CompressionState } from "../types.js";
import type { LLMMessage } from "../llm.js";

/**
 * Integration tests for cache-stable compression pipeline.
 *
 * "Cache-stable" = for any message at position i in turn N,
 * if the same logical message appears in turn N+1, its content
 * must be identical (preserving LLM prefix cache / KV cache).
 */

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    model: "test",
    apiKey: "k",
    systemPrompt: "You are a test agent.",
    tools: [
      { name: "grep", description: "search", parameters: {} },
    ],
    maxTurns: 5,
    maxContextTokens: 100_000,
    ...overrides,
  };
}

/** Extract shared prefix length of two message arrays by JSON equality. */
function sharedPrefixLength(a: LLMMessage[], b: LLMMessage[]): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) break;
    i++;
  }
  return i;
}

describe("cache-stability: compression pipeline", () => {
  let shell: MockShell;
  let session: ChatSession;
  let queue: MessageQueue;

  beforeEach(() => {
    shell = new MockShell();
    session = new ChatSession("/tmp/cache-test.jsonl", shell);
    queue = new MessageQueue();
  });

  it("microcompact watermark keeps truncated content stable across loops", async () => {
    const bigContent = "x".repeat(5000);
    const config = makeConfig();
    const compState: CompressionState = { microcompactWatermark: 0, collapseProcessedCount: 0 };

    // Run 5 separate react-loops, each doing: user msg → tool call → text
    // This builds up 5 tool-call groups in the session.
    const allCaptures: LLMMessage[][] = [];

    for (let i = 1; i <= 5; i++) {
      const llm = new MockLLM();
      // Seed a user question into the queue
      queue.enqueue({ content: `question ${i}`, from: "user", ts: String(i) });
      // LLM calls grep, then responds with text
      llm.addToolCallResponse([{ id: `g${i}`, name: "grep", arguments: {} }]);
      llm.addTextResponse(`answer ${i}`);

      await runReactLoop({
        session, queue, config, llm,
        tools: { grep: async () => bigContent },
        compressionState: compState,
      });

      // Capture the messages from the TEXT response call (2nd call = index 1)
      allCaptures.push(llm.capturedMessages[1]);
    }

    // With keepRecentGroups=3, by loop 5 we have watermark=2 (groups 1-2 truncated)
    expect(compState.microcompactWatermark).toBe(2);

    // Key assertion: the shared prefix between consecutive text-response calls
    // should be stable. Specifically, between loop 4 and loop 5:
    // - Groups 1 was already truncated in loop 4, stays truncated in loop 5
    // - Group 2 is newly truncated in loop 5 (this is the ONE expected break)
    // - Everything before the break point should be identical
    const msgs4 = allCaptures[3]; // loop 4's text call
    const msgs5 = allCaptures[4]; // loop 5's text call
    const shared = sharedPrefixLength(msgs4, msgs5);

    // System prompt (1 msg) + user msg "question 1" + truncated group 1 (already truncated in both)
    // = at least 3-4 messages of stable prefix
    expect(shared).toBeGreaterThanOrEqual(3);
  });

  it("collapse processedCount prevents retroactive rewriting across loops", async () => {
    const config = makeConfig();
    const compState: CompressionState = { microcompactWatermark: 0, collapseProcessedCount: 0 };

    const allCaptures: LLMMessage[][] = [];

    // Loop 1-2: grep returns "(no matches)" — 2 failed groups, not collapsed
    for (let i = 1; i <= 2; i++) {
      const llm = new MockLLM();
      queue.enqueue({ content: `search ${i}`, from: "user", ts: String(i) });
      llm.addToolCallResponse([{ id: `g${i}`, name: "grep", arguments: {} }]);
      llm.addTextResponse(`nothing found ${i}`);

      await runReactLoop({
        session, queue, config, llm,
        tools: { grep: async () => "(no matches)" },
        compressionState: compState,
      });
      allCaptures.push(llm.capturedMessages[1]);
    }

    // Loop 3: another "(no matches)" — total 3 failed groups.
    // WITHOUT processedCount, this would retroactively collapse groups 1-2.
    // WITH processedCount, groups 1-2 are frozen.
    const llm3 = new MockLLM();
    queue.enqueue({ content: "search 3", from: "user", ts: "3" });
    llm3.addToolCallResponse([{ id: "g3", name: "grep", arguments: {} }]);
    llm3.addTextResponse("giving up");

    await runReactLoop({
      session, queue, config, llm: llm3,
      tools: { grep: async () => "(no matches)" },
      compressionState: compState,
    });
    allCaptures.push(llm3.capturedMessages[1]);

    // The messages from loop 2's text call and loop 3's text call
    const msgs2 = allCaptures[1];
    const msgs3 = allCaptures[2];

    // Groups 1-2 should appear verbatim in both — NOT collapsed into a summary
    const msgs2str = JSON.stringify(msgs2);
    const msgs3str = JSON.stringify(msgs3);
    expect(msgs2str).toContain("(no matches)");
    expect(msgs3str).toContain("(no matches)");

    // No "[X tool-call groups collapsed]" summary should appear
    expect(msgs3str).not.toContain("groups collapsed");

    // Shared prefix should cover system prompt + frozen messages
    const shared = sharedPrefixLength(msgs2, msgs3);
    expect(shared).toBeGreaterThanOrEqual(3);
  });

  it("dynamic system prompt is a separate message from stable prompt", async () => {
    const config = makeConfig({
      dynamicSystemPrompt: "## Session Memory\nUser works on cache optimization.",
    });
    const llm = new MockLLM();

    await session.append({ ts: "0", role: "user", content: "hi" });
    llm.addTextResponse("hello");

    await runReactLoop({ session, queue, config, llm, tools: {} });

    const msgs = llm.capturedMessages[0];
    // msgs[0]: stable system prompt
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("You are a test agent.");
    // msgs[1]: dynamic system prompt
    expect(msgs[1].role).toBe("system");
    expect(msgs[1].content).toContain("Session Memory");
    // msgs[2]: the user message
    expect(msgs[2].role).toBe("user");
  });

  it("emergency retry preserves all system messages", async () => {
    const config = makeConfig({
      dynamicSystemPrompt: "## Recalled Memories\nAlice is a backend engineer.",
      maxTurns: 2,
    });
    const llm = new MockLLM();

    await session.append({ ts: "0", role: "user", content: "test" });

    // First call: prompt too long, second: success
    llm.addErrorResponse(new Error("context_length_exceeded: too many tokens"));
    llm.addTextResponse("Recovered!");

    const result = await runReactLoop({ session, queue, config, llm, tools: {} });
    expect(result).toBe("Recovered!");

    // The retry call (index 1) should have both system messages
    const retryMsgs = llm.capturedMessages[1];
    const systemMsgs = retryMsgs.filter((m: LLMMessage) => m.role === "system");
    // stable + dynamic + emergency hint = 3
    expect(systemMsgs.length).toBeGreaterThanOrEqual(3);
    expect(systemMsgs[0].content).toBe("You are a test agent.");
    expect(systemMsgs[1].content).toContain("Recalled Memories");
    expect(systemMsgs[2].content).toContain("Emergency context reduction");
  });
});
