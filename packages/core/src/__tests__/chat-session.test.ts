import { describe, it, expect, beforeEach } from "vitest";
import { ChatSession } from "../chat-session.js";
import { MockShell } from "./fixtures/mock-shell.js";

describe("ChatSession", () => {
  let shell: MockShell;
  let session: ChatSession;

  beforeEach(() => {
    shell = new MockShell();
    session = new ChatSession("/tmp/test.jsonl", shell);
  });

  it("append writes JSONL line", async () => {
    await session.append({ ts: "1", role: "user", content: "hello" });

    const raw = shell.files.get("/tmp/test.jsonl")!;
    const parsed = JSON.parse(raw.trim());
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("hello");
  });

  it("append is additive", async () => {
    await session.append({ ts: "1", role: "user", content: "a" });
    await session.append({ ts: "2", role: "assistant", content: "b" });

    const raw = shell.files.get("/tmp/test.jsonl")!;
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("readAll returns all messages", async () => {
    await session.append({ ts: "1", role: "user", content: "a" });
    await session.append({ ts: "2", role: "assistant", content: "b" });

    const messages = await session.readAll();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("a");
    expect(messages[1].content).toBe("b");
  });

  it("readAll returns empty array for missing file", async () => {
    const messages = await session.readAll();
    expect(messages).toEqual([]);
  });

  it("readTail returns last N messages", async () => {
    await session.append({ ts: "1", role: "user", content: "a" });
    await session.append({ ts: "2", role: "user", content: "b" });
    await session.append({ ts: "3", role: "user", content: "c" });

    const tail = await session.readTail(2);
    expect(tail).toHaveLength(2);
    expect(tail[0].content).toBe("b");
    expect(tail[1].content).toBe("c");
  });

  it("preserves meta through round-trip", async () => {
    await session.append({
      ts: "1",
      role: "user",
      content: "hi",
      meta: { chat_id: "123", sender_name: "Alice" },
    });

    const [msg] = await session.readAll();
    expect(msg.meta?.chat_id).toBe("123");
    expect(msg.meta?.sender_name).toBe("Alice");
  });
});
