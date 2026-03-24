import { describe, it, expect } from "vitest";
import { MouthAgent } from "../../mouth-agent.js";
import { createOpenAIClient } from "../../providers/openai.js";
import { MockShell } from "../fixtures/mock-shell.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BASE_URL =
  process.env.GITHUB_MODELS_ENDPOINT ?? "https://models.inference.ai.azure.com";
const MODEL = process.env.GITHUB_MODELS_MODEL ?? "gpt-4.1-mini";

/** Poll until predicate returns true, or throw on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe.skipIf(!GITHUB_TOKEN)("E2E: multi-channel routing", () => {
  it("routes replies to correct channel:chatId without cross-talk", async () => {
    // --- wiring ---
    const shell = new MockShell();
    const llm = createOpenAIClient(GITHUB_TOKEN!, BASE_URL);

    const sentMessages: Array<{ chatId: string; text: string }> = [];
    const sendMessage = async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
    };

    const mouth = new MouthAgent({
      sessionsDir: "/tmp/sessions",
      config: { model: MODEL, apiKey: GITHUB_TOKEN!, maxTurns: 10 },
      llm,
      handConfig: { model: MODEL, apiKey: GITHUB_TOKEN!, maxTurns: 5 },
      handLlm: llm,
      sendMessage,
      shell,
    });

    // --- act: two messages from different channels, clearly distinct topics ---
    await mouth.handleMessage("1 + 1 等于几？直接告诉我答案就好", {
      chatId: "telegram:alice",
      senderId: "alice",
      senderName: "Alice",
      channel: "telegram",
    });

    await mouth.handleMessage("法国的首都是哪个城市？直接告诉我答案就好", {
      chatId: "wechat:bob",
      senderId: "bob",
      senderName: "Bob",
      channel: "wechat",
    });

    // --- wait for BOTH channels to have at least one reply ---
    const aliceHasReply = () =>
      sentMessages.some((m) => m.chatId === "telegram:alice");
    const bobHasReply = () =>
      sentMessages.some((m) => m.chatId === "wechat:bob");
    await waitFor(() => aliceHasReply() && bobHasReply(), 90_000);

    // --- assert: correct routing ---
    const aliceReplies = sentMessages.filter(
      (m) => m.chatId === "telegram:alice",
    );
    const bobReplies = sentMessages.filter((m) => m.chatId === "wechat:bob");

    expect(aliceReplies.length).toBeGreaterThanOrEqual(1);
    expect(bobReplies.length).toBeGreaterThanOrEqual(1);

    // Alice asked about math → reply should contain "2" (digit or Chinese)
    const aliceText = aliceReplies.map((m) => m.text).join(" ");
    expect(aliceText).toMatch(/2|二|两/);

    // Bob asked about geography → reply should mention Paris
    const bobText = bobReplies.map((m) => m.text).join(" ");
    expect(bobText).toMatch(/巴黎|Paris/i);
  }, 120_000);
});
