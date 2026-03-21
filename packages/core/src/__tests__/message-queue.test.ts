import { describe, it, expect } from "vitest";
import { MessageQueue } from "../message-queue.js";

describe("MessageQueue", () => {
  it("enqueue and drain all", () => {
    const q = new MessageQueue();
    q.enqueue({ content: "a", from: "u", ts: "1" });
    q.enqueue({ content: "b", from: "u", ts: "2" });

    expect(q.length).toBe(2);
    const items = q.drain();
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe("a");
    expect(q.length).toBe(0);
  });

  it("drain with max", () => {
    const q = new MessageQueue();
    q.enqueue({ content: "a", from: "u", ts: "1" });
    q.enqueue({ content: "b", from: "u", ts: "2" });
    q.enqueue({ content: "c", from: "u", ts: "3" });

    const batch = q.drain(2);
    expect(batch).toHaveLength(2);
    expect(q.length).toBe(1);
    expect(q.drain()[0].content).toBe("c");
  });

  it("check returns first and removes it", () => {
    const q = new MessageQueue();
    q.enqueue({ content: "x", from: "u", ts: "1" });

    const msg = q.check();
    expect(msg?.content).toBe("x");
    expect(q.length).toBe(0);
  });

  it("check returns null when empty", () => {
    const q = new MessageQueue();
    expect(q.check()).toBeNull();
  });

  it("preserves meta through enqueue/drain", () => {
    const q = new MessageQueue();
    q.enqueue({
      content: "hi",
      from: "u",
      ts: "1",
      meta: { chat_id: "123", sender_id: "456", channel: "telegram" },
    });

    const [msg] = q.drain();
    expect(msg.meta?.chat_id).toBe("123");
    expect(msg.meta?.channel).toBe("telegram");
  });
});
