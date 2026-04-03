/**
 * Manual e2e test for context compression & memory features.
 * Run with: ANTHROPIC_API_KEY=... npx tsx packages/core/src/__tests__/e2e/run-compression-test.ts
 */
import { MouthAgent } from "../../mouth-agent.js";
import { createAnthropicClient } from "../../providers/anthropic.js";
import { MockShell } from "../fixtures/mock-shell.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this test");
  process.exit(1);
}

const MODEL = "claude-sonnet-4-6";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 120_000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function testMemoryRecall() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 1: Memory Recall — LLM 选取相关记忆并注入 context");
  console.log("=".repeat(60));

  const shell = new MockShell();
  const llm = createAnthropicClient(API_KEY!);
  const sent: Array<{ chatId: string; text: string }> = [];

  // Set up 4 memory files (≥3 triggers recall)
  shell.files.set(
    ".jawclaw/memory/MEMORY.md",
    "# Memory Index\n- contacts/alice.md\n- contacts/bob.md\n- project-goals.md",
  );
  shell.files.set(
    ".jawclaw/memory/contacts/alice.md",
    "# Alice\nAlice 是后端工程师，擅长 Rust 和 Go。邮箱 alice@example.com。她养了两只猫。",
  );
  shell.files.set(
    ".jawclaw/memory/contacts/bob.md",
    "# Bob\nBob 是产品经理，Slack: @bob-pm。他负责 Q2 路线图。",
  );
  shell.files.set(
    ".jawclaw/memory/project-goals.md",
    "# Project Goals\nQ2: 完成 context compression 升级。截止 2026-06-30。",
  );

  const mouth = new MouthAgent({
    sessionsDir: "/tmp/sessions-recall",
    config: { model: MODEL, apiKey: API_KEY!, maxTurns: 5 },
    llm,
    handConfig: { model: MODEL, apiKey: API_KEY!, maxTurns: 3 },
    handLlm: llm,
    sendMessage: async (id, text) => { sent.push({ chatId: id, text }); },
    shell,
  });

  await mouth.handleMessage("Alice 的邮箱是什么？直接回复我就好。", {
    chatId: "test:user1", senderId: "user1", senderName: "Tester", channel: "test",
  });

  await waitFor(() => sent.length >= 1, 60_000);

  const reply = sent.map((m) => m.text).join(" ");
  console.log(`📤 Reply: ${reply}`);
  const pass = reply.toLowerCase().includes("alice@example.com");
  console.log(pass ? "✅ PASS — Agent recalled Alice's email from memory" : "❌ FAIL — Reply did not contain alice@example.com");
  return pass;
}

async function testMicrocompaction() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 2: Microcompaction — 小 context window 下仍能多轮对话");
  console.log("=".repeat(60));

  const shell = new MockShell();
  const llm = createAnthropicClient(API_KEY!);
  const sent: Array<{ chatId: string; text: string }> = [];

  // Create a file for the agent to read
  shell.files.set("/project/data.ts", "export const items = [\n" + Array.from({ length: 50 }, (_, i) => `  { id: ${i}, name: "item_${i}" },`).join("\n") + "\n];\n");

  const mouth = new MouthAgent({
    sessionsDir: "/tmp/sessions-compact",
    config: {
      model: MODEL,
      apiKey: API_KEY!,
      maxTurns: 5,
      maxContextTokens: 6_000, // Very small — forces compaction
    },
    llm,
    handConfig: { model: MODEL, apiKey: API_KEY!, maxTurns: 3 },
    handLlm: llm,
    sendMessage: async (id, text) => { sent.push({ chatId: id, text }); },
    shell,
  });

  // Round 1: Ask to read the file
  await mouth.handleMessage("读取 /project/data.ts，告诉我里面有多少个 item。用 message 工具回复。", {
    chatId: "test:user1", senderId: "user1", senderName: "Tester", channel: "test",
  });
  await waitFor(() => sent.length >= 1, 60_000);
  console.log(`📤 Round 1 reply: ${sent[sent.length - 1].text.slice(0, 200)}`);

  // Round 2: Follow-up — context should be compacted but still usable
  await mouth.handleMessage("最后一个 item 的 id 是多少？", {
    chatId: "test:user1", senderId: "user1", senderName: "Tester", channel: "test",
  });
  await waitFor(() => sent.length >= 2, 60_000);
  console.log(`📤 Round 2 reply: ${sent[sent.length - 1].text.slice(0, 200)}`);

  // Check session file for compaction evidence
  const session = shell.files.get("/tmp/sessions-compact/mouth.jsonl") ?? "";
  const msgCount = session.split("\n").filter((l) => l.trim()).length;
  console.log(`📊 Session messages: ${msgCount}`);

  const pass = sent.length >= 2;
  console.log(pass ? "✅ PASS — Agent handled multi-round with small context" : "❌ FAIL — Agent failed to respond in round 2");
  return pass;
}

async function testSessionMemoryExtraction() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 3: Session Memory Extraction — 后台提取结构化笔记");
  console.log("=".repeat(60));

  const shell = new MockShell();
  const llm = createAnthropicClient(API_KEY!);
  const sent: Array<{ chatId: string; text: string }> = [];

  // Pre-seed session with realistic alternating messages to trigger extraction.
  // Must maintain proper user/assistant alternation for Anthropic API.
  const sessionPath = "/tmp/sessions-extract/mouth.jsonl";
  const msgs: string[] = [];
  const topics = [
    ["API endpoint 设计 /users/:id 怎么做比较好？", "建议用 REST 风格，GET /users/:id 返回用户详情。"],
    ["错误处理呢？", "统一用 JSON error body，包含 code 和 message 字段。"],
    ["需要做分页吗？", "列表接口用 cursor-based 分页，避免 offset 的性能问题。"],
    ["认证方案用什么？", "JWT Bearer token，access token 15 分钟过期，refresh token 7 天。"],
    ["数据库选型？", "PostgreSQL 适合这个场景，配合 Prisma ORM。"],
    ["缓存策略呢？", "热点数据用 Redis，TTL 5 分钟，写时失效。"],
    ["日志方案？", "用 structured logging，JSON 格式，接入 Grafana Loki。"],
    ["部署方式？", "Docker + K8s，CI/CD 用 GitHub Actions。"],
    ["监控告警？", "Prometheus metrics + Alertmanager，P99 延迟超 500ms 告警。"],
  ];
  // First: a few tool-call groups (user → assistant+tool → tool_result → assistant response)
  for (let i = 0; i < 3; i++) {
    msgs.push(JSON.stringify({
      ts: new Date().toISOString(), role: "user",
      content: `请帮我查看 /src/api/route${i}.ts`,
      meta: { chat_id: "test:user1", sender_id: "user1", sender_name: "Tester", channel: "test" },
    }));
    msgs.push(JSON.stringify({
      ts: new Date().toISOString(), role: "assistant", content: "",
      meta: { tool_calls: [{ id: `t${i}`, name: "read_file", arguments: { path: `/src/api/route${i}.ts` } }] },
    }));
    msgs.push(JSON.stringify({
      ts: new Date().toISOString(), role: "tool",
      content: `export function handler${i}() { return "route ${i}"; }`,
      meta: { tool_call_id: `t${i}`, tool_name: "read_file" },
    }));
    msgs.push(JSON.stringify({
      ts: new Date().toISOString(), role: "assistant",
      content: `这个文件定义了 handler${i}，是一个简单的路由处理函数。`,
    }));
  }
  // Then: normal conversation (alternating user/assistant)
  for (const [q, a] of topics) {
    msgs.push(JSON.stringify({
      ts: new Date().toISOString(), role: "user", content: q,
      meta: { chat_id: "test:user1", sender_id: "user1", sender_name: "Tester", channel: "test" },
    }));
    msgs.push(JSON.stringify({
      ts: new Date().toISOString(), role: "assistant", content: a,
    }));
  }
  shell.files.set(sessionPath, msgs.join("\n") + "\n");
  // Total: 3*4 + 9*2 = 30 messages, with 3 tool calls

  const memRoot = "/tmp/memory-extract";

  const mouth = new MouthAgent({
    sessionsDir: "/tmp/sessions-extract",
    config: { model: MODEL, apiKey: API_KEY!, maxTurns: 5 },
    llm,
    handConfig: { model: MODEL, apiKey: API_KEY!, maxTurns: 3 },
    handLlm: llm,
    sendMessage: async (id, text) => { sent.push({ chatId: id, text }); },
    shell,
    handServices: { memoryRoot: memRoot },
  });

  // This message pushes past the threshold (30 pre-seeded + this one ≥ 20 new)
  await mouth.handleMessage("好的，我们继续讨论 API 设计。用 message 工具回复我。", {
    chatId: "test:user1", senderId: "user1", senderName: "Tester", channel: "test",
  });

  // Wait for either a reply or timeout — the reply isn't the focus of this test
  try {
    await waitFor(() => sent.length >= 1, 30_000);
    console.log(`📤 Reply: ${sent[0]?.text.slice(0, 200)}`);
  } catch {
    console.log("⚠️  Mouth didn't reply via message tool (not critical for this test)");
  }

  // Wait for fire-and-forget extraction to complete
  console.log("⏳ Waiting for session memory extraction (20s)...");
  await new Promise((r) => setTimeout(r, 20_000));

  const memoryFile = shell.files.get(`${memRoot}/session-memory.md`);
  const checkpoint = shell.files.get(`${memRoot}/.session-memory-checkpoint`);

  if (memoryFile) {
    console.log(`📝 Session memory (${memoryFile.length} chars):`);
    console.log(memoryFile.slice(0, 600));
    console.log(checkpoint ? `📌 Checkpoint: ${checkpoint}` : "📌 No checkpoint");
    console.log("✅ PASS — Session memory extracted");
    return true;
  } else {
    console.log("⚠️  Session memory not yet written (extraction may still be running)");
    console.log("Available files:", [...shell.files.keys()].filter((k) => k.startsWith(memRoot)));
    return false;
  }
}

// Run all tests
(async () => {
  console.log(`🧪 Running context compression e2e tests with ${MODEL}\n`);

  const results: boolean[] = [];

  try { results.push(await testMemoryRecall()); } catch (e) { console.error("❌ Test 1 error:", e); results.push(false); }
  try { results.push(await testMicrocompaction()); } catch (e) { console.error("❌ Test 2 error:", e); results.push(false); }
  try { results.push(await testSessionMemoryExtraction()); } catch (e) { console.error("❌ Test 3 error:", e); results.push(false); }

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Test 1 (Memory Recall):     ${results[0] ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Test 2 (Microcompaction):   ${results[1] ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Test 3 (Session Memory):    ${results[2] ? "✅ PASS" : "❌ FAIL"}`);

  const allPass = results.every((r) => r);
  console.log(`\nOverall: ${allPass ? "✅ ALL PASSED" : "❌ SOME FAILED"}`);
  process.exit(allPass ? 0 : 1);
})();
