import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChannelMessage } from "../channel.js";

// Mock the Lark SDK before importing FeishuChannel
const mockCreate = vi.fn();
const mockStart = vi.fn();
const mockClose = vi.fn();
let registeredHandler: ((data: unknown) => Promise<void>) | null = null;

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class MockClient {
    im = { message: { create: mockCreate } };
    constructor(_opts: unknown) {}
  },
  EventDispatcher: class MockDispatcher {
    constructor(_opts: unknown) {}
    register(handles: Record<string, Function>) {
      registeredHandler = handles["im.message.receive_v1"] as
        | ((data: unknown) => Promise<void>)
        | null;
      return this;
    }
  },
  WSClient: class MockWSClient {
    start = mockStart;
    close = mockClose;
    constructor(_opts: unknown) {}
  },
  LoggerLevel: { error: 1 },
}));

// Import after mocking
import { FeishuChannel } from "../feishu.js";

/** Helper to build a mock Feishu im.message.receive_v1 event. */
function makeFeishuEvent(
  chatId: string,
  senderId: string,
  text: string,
  messageType = "text",
  senderType = "user",
) {
  const content =
    messageType === "text"
      ? JSON.stringify({ text })
      : messageType === "post"
        ? JSON.stringify({
            title: "Post Title",
            content: [[{ tag: "text", text }]],
          })
        : text;

  return {
    sender: {
      sender_id: { open_id: senderId, user_id: senderId },
      sender_type: senderType,
    },
    message: {
      message_id: "msg-" + Date.now(),
      chat_id: chatId,
      chat_type: "p2p",
      message_type: messageType,
      content,
    },
  };
}

describe("FeishuChannel", () => {
  let channel: FeishuChannel;
  let received: ChannelMessage[];

  beforeEach(() => {
    received = [];
    vi.clearAllMocks();
    registeredHandler = null;
    mockStart.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({ code: 0 });

    channel = new FeishuChannel("app-id", "app-secret");
    channel.onMessage(async (msg) => {
      received.push(msg);
    });
  });

  describe("start / stop", () => {
    it("starts WebSocket connection", async () => {
      await channel.start();
      expect(mockStart).toHaveBeenCalledWith({
        eventDispatcher: expect.anything(),
      });
    });

    it("closes WebSocket on stop", async () => {
      await channel.stop();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("delivers text messages to handler", async () => {
      await channel.start();
      expect(registeredHandler).not.toBeNull();

      await registeredHandler!(makeFeishuEvent("chat1", "user1", "hello"));

      expect(received).toHaveLength(1);
      expect(received[0].chatId).toBe("chat1");
      expect(received[0].senderId).toBe("user1");
      expect(received[0].text).toBe("hello");
      expect(received[0].channel).toBe("feishu");
    });

    it("extracts text from post messages", async () => {
      await channel.start();

      await registeredHandler!(
        makeFeishuEvent("chat1", "user1", "post body", "post"),
      );

      expect(received).toHaveLength(1);
      expect(received[0].text).toContain("Post Title");
      expect(received[0].text).toContain("post body");
    });

    it("handles unknown message types with type label", async () => {
      await channel.start();

      await registeredHandler!(
        makeFeishuEvent("chat1", "user1", "{}", "image"),
      );

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("(image message)");
    });

    it("skips bot messages to avoid self-loops", async () => {
      await channel.start();

      await registeredHandler!(
        makeFeishuEvent("chat1", "bot1", "echo", "text", "app"),
      );

      expect(received).toHaveLength(0);
    });

    it("strips @mention placeholders from text", async () => {
      await channel.start();

      await registeredHandler!(
        makeFeishuEvent("chat1", "user1", "@_user_1 hello @_user_2"),
      );

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("hello");
    });

    it("skips events with missing sender or message", async () => {
      await channel.start();

      await registeredHandler!({ sender: null, message: null });
      await registeredHandler!({});

      expect(received).toHaveLength(0);
    });

    it("handles malformed content JSON gracefully", async () => {
      await channel.start();

      const event = makeFeishuEvent("chat1", "user1", "not-json");
      (event.message as Record<string, unknown>).content = "not-json";

      await registeredHandler!(event);

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("not-json");
    });
  });

  describe("sendReply", () => {
    it("sends text message via Lark API", async () => {
      await channel.sendReply("chat1", "hello");

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "chat1",
          msg_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      });
    });

    it("chunks long text", async () => {
      const longText = "x".repeat(5000);
      await channel.sendReply("chat1", longText);

      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("stops sending on error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockCreate
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({ code: 0 });

      const longText = "y".repeat(5000);
      await channel.sendReply("chat1", longText);

      // Should have tried once, failed, and stopped
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send"),
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });
  });

  describe("sendTyping", () => {
    it("is a no-op", async () => {
      await channel.sendTyping("chat1");
      // No API calls made
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("post text extraction", () => {
    it("extracts multi-paragraph post content", async () => {
      await channel.start();

      const event = {
        sender: {
          sender_id: { open_id: "u1" },
          sender_type: "user",
        },
        message: {
          message_id: "m1",
          chat_id: "c1",
          chat_type: "p2p",
          message_type: "post",
          content: JSON.stringify({
            title: "Title",
            content: [
              [{ tag: "text", text: "line 1" }, { tag: "text", text: " continued" }],
              [{ tag: "text", text: "line 2" }],
            ],
          }),
        },
      };

      await registeredHandler!(event);

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("Title\nline 1 continued\nline 2");
    });

    it("handles post without title", async () => {
      await channel.start();

      const event = {
        sender: {
          sender_id: { open_id: "u1" },
          sender_type: "user",
        },
        message: {
          message_id: "m1",
          chat_id: "c1",
          chat_type: "p2p",
          message_type: "post",
          content: JSON.stringify({
            content: [[{ tag: "text", text: "only body" }]],
          }),
        },
      };

      await registeredHandler!(event);

      expect(received).toHaveLength(1);
      expect(received[0].text).toBe("only body");
    });
  });
});
