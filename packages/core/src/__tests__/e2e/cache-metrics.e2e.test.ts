import { describe, it, expect } from "vitest";
import { createAnthropicClient } from "../../providers/anthropic.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

describe.skipIf(!ANTHROPIC_API_KEY)("E2E: Anthropic cache_control", () => {
  it("returns cache metrics and achieves cache hit on second call", async () => {
    const llm = createAnthropicClient(ANTHROPIC_API_KEY!);
    // Need >2048 tokens of cacheable content for Sonnet to enable caching
    const stablePrompt = ("You are a helpful agent that assists users with various tasks. " +
      "You have deep knowledge of programming, science, and general topics. ").repeat(80);
    const tools = [
      { name: "search", description: "Search for information on a topic. Returns relevant results.", parameters: { type: "object", properties: { query: { type: "string" } } } },
      { name: "calculate", description: "Perform mathematical calculations.", parameters: { type: "object", properties: { expression: { type: "string" } } } },
    ];

    // First call: should create cache
    const r1 = await llm.createCompletion({
      model: MODEL,
      messages: [
        { role: "system", content: stablePrompt },
        { role: "system", content: "Dynamic: user prefers concise answers." },
        { role: "user", content: "Say hi in one word." },
      ],
      tools,
    });

    console.log("Call 1 cache:", JSON.stringify(r1.cacheMetrics));
    console.log("Call 1 usage:", JSON.stringify(r1.usage));

    // Expect cache creation on first call
    const creation = r1.cacheMetrics?.cacheCreationTokens ?? 0;
    console.log(`Call 1: created ${creation} cache tokens`);
    expect(creation).toBeGreaterThan(0);

    // Second call with same stable prefix: should read from cache
    const r2 = await llm.createCompletion({
      model: MODEL,
      messages: [
        { role: "system", content: stablePrompt },
        { role: "system", content: "Dynamic: user prefers concise answers." },
        { role: "user", content: "Say hi in one word." },
        { role: "assistant", content: r1.content ?? "Hi!" },
        { role: "user", content: "Now say bye in one word." },
      ],
      tools,
    });

    console.log("Call 2 cache:", JSON.stringify(r2.cacheMetrics));
    console.log("Call 2 usage:", JSON.stringify(r2.usage));

    // On second call, cacheReadTokens should be > 0
    const read = r2.cacheMetrics?.cacheReadTokens ?? 0;
    console.log(`Call 2: read ${read} tokens from cache`);
    expect(read).toBeGreaterThan(0);
  }, 30_000);
});
