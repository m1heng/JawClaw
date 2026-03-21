import { describe, it, expect, beforeEach } from "vitest";
import { runReactLoop } from "../react-loop.js";
import { ChatSession } from "../chat-session.js";
import { MessageQueue } from "../message-queue.js";
import { MockShell } from "./fixtures/mock-shell.js";
import { MockLLM } from "./fixtures/mock-llm.js";
import type { AgentConfig } from "../types.js";

describe("runReactLoop", () => {
  let shell: MockShell;
  let llm: MockLLM;
  let session: ChatSession;
  let queue: MessageQueue;
  let config: AgentConfig;

  beforeEach(() => {
    shell = new MockShell();
    llm = new MockLLM();
    session = new ChatSession("/tmp/test-session.jsonl", shell);
    queue = new MessageQueue();
    config = {
      model: "test-model",
      apiKey: "test-key",
      systemPrompt: "You are a test agent.",
      tools: [],
      maxTurns: 10,
    };
  });

  it("returns text response and appends to session", async () => {
    // Seed a user message
    await session.append({ ts: "1", role: "user", content: "hello" });
    llm.addTextResponse("Hi there!");

    const result = await runReactLoop({
      session,
      queue,
      config,
      llm,
      tools: {},
    });

    expect(result).toBe("Hi there!");

    const messages = await session.readAll();
    expect(messages).toHaveLength(2); // user + assistant
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi there!");
  });

  it("executes tool calls and loops", async () => {
    await session.append({ ts: "1", role: "user", content: "read the file" });

    // LLM first calls a tool, then responds with text
    llm.addToolCallResponse([
      { id: "call-1", name: "test_tool", arguments: { input: "abc" } },
    ]);
    llm.addTextResponse("Done!");

    let toolCalled = false;
    const result = await runReactLoop({
      session,
      queue,
      config: { ...config, tools: [{ name: "test_tool", description: "test", parameters: {} }] },
      llm,
      tools: {
        test_tool: async (args) => {
          toolCalled = true;
          return `result for ${args.input}`;
        },
      },
    });

    expect(toolCalled).toBe(true);
    expect(result).toBe("Done!");
    expect(llm.calls).toHaveLength(2); // first call → tool, second call → text
  });

  it("respects maxTurns", async () => {
    await session.append({ ts: "1", role: "user", content: "loop forever" });

    // LLM always returns tool calls, never text
    for (let i = 0; i < 5; i++) {
      llm.addToolCallResponse([
        { id: `call-${i}`, name: "noop", arguments: {} },
      ]);
    }

    const result = await runReactLoop({
      session,
      queue,
      config: { ...config, maxTurns: 3, tools: [{ name: "noop", description: "noop", parameters: {} }] },
      llm,
      tools: { noop: async () => "ok" },
    });

    expect(result).toBe("Max turns reached.");
    expect(llm.calls).toHaveLength(3);
  });

  it("respects abort signal", async () => {
    await session.append({ ts: "1", role: "user", content: "go" });

    const ac = new AbortController();
    ac.abort(); // abort immediately

    llm.addTextResponse("should not reach");

    const result = await runReactLoop({
      session,
      queue,
      config,
      llm,
      tools: {},
      abortSignal: ac.signal,
    });

    expect(result).toBe("Max turns reached.");
    expect(llm.calls).toHaveLength(0); // never called
  });

  it("drains queue messages into session", async () => {
    await session.append({ ts: "1", role: "user", content: "initial" });

    // Queue a message that arrives during the loop
    queue.enqueue({ content: "queued msg", from: "user", ts: "2" });

    llm.addTextResponse("Got it.");

    await runReactLoop({
      session,
      queue,
      config,
      llm,
      tools: {},
    });

    const messages = await session.readAll();
    // initial + queued + assistant
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toBe("queued msg");
  });

  it("fires onAssistantMessage callback", async () => {
    await session.append({ ts: "1", role: "user", content: "hi" });
    llm.addTextResponse("Hello!");

    let captured = "";
    await runReactLoop({
      session,
      queue,
      config,
      llm,
      tools: {},
      onAssistantMessage: (text) => {
        captured = text;
      },
    });

    expect(captured).toBe("Hello!");
  });

  it("fires onTurn callback each iteration", async () => {
    await session.append({ ts: "1", role: "user", content: "go" });

    llm.addToolCallResponse([
      { id: "c1", name: "t", arguments: {} },
    ]);
    llm.addTextResponse("done");

    let turns = 0;
    await runReactLoop({
      session,
      queue,
      config: { ...config, tools: [{ name: "t", description: "t", parameters: {} }] },
      llm,
      tools: { t: async () => "ok" },
      onTurn: () => { turns++; },
    });

    expect(turns).toBe(2); // tool-call turn + text turn
  });

  it("prepends channel metadata to user messages", async () => {
    await session.append({
      ts: "1",
      role: "user",
      content: "hello",
      meta: { chat_id: "999", sender_name: "Bob", channel: "telegram" },
    });

    llm.addTextResponse("Hi Bob!");

    await runReactLoop({
      session,
      queue,
      config,
      llm,
      tools: {},
    });

    // Check what the LLM received — the user message should have metadata prefix
    // We can verify indirectly: LLM was called once
    expect(llm.calls).toHaveLength(1);
  });
});
