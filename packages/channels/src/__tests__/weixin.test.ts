import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WeixinChannel } from "../weixin.js";
import type { ChannelMessage } from "../channel.js";

/** Helper to build a mock WeChat inbound message. */
function makeWxMsg(
  userId: string,
  text: string,
  contextToken = "ctx-" + userId,
) {
  return {
    message_type: 1,
    from_user_id: userId,
    context_token: contextToken,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text } }],
  };
}

const emptyRes = () => ({
  ok: true,
  json: async () => ({ ret: 0, msgs: [], get_updates_buf: "init" }),
});

describe("WeixinChannel", () => {
  let channel: WeixinChannel;
  let fetchMock: ReturnType<typeof vi.fn>;
  let received: ChannelMessage[];

  beforeEach(() => {
    received = [];
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    channel = new WeixinChannel("test-token", "https://wx.test");
    channel.onMessage(async (msg) => {
      received.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("message handling", () => {
    it("delivers text messages to handler", async () => {
      // Call 1: validation in start(), Call 2: poll with message, Call 3: stop
      let callCount = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("getupdates")) {
          callCount++;
          if (callCount === 1) return emptyRes();
          if (callCount === 2) {
            return {
              ok: true,
              json: async () => ({
                ret: 0,
                msgs: [makeWxMsg("user1", "hello")],
                get_updates_buf: "buf1",
              }),
            };
          }
          await channel.stop();
          return emptyRes();
        }
        return { ok: true, json: async () => ({}) };
      });

      await channel.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));

      expect(received[0].chatId).toBe("user1");
      expect(received[0].text).toBe("hello");
      expect(received[0].senderId).toBe("user1");
      expect(received[0].channel).toBe("weixin");
    });

    it("skips bot messages (message_type !== 1)", async () => {
      let callCount = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("getupdates")) {
          callCount++;
          if (callCount === 1) return emptyRes();
          if (callCount === 2) {
            return {
              ok: true,
              json: async () => ({
                ret: 0,
                msgs: [{ ...makeWxMsg("bot", "echo"), message_type: 2 }],
                get_updates_buf: "buf2",
              }),
            };
          }
          await channel.stop();
          return emptyRes();
        }
        return { ok: true, json: async () => ({}) };
      });

      await channel.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(0);
    });

    it("extracts voice transcription", async () => {
      let callCount = 0;
      const voiceMsg = {
        message_type: 1,
        from_user_id: "user2",
        context_token: "ctx-voice",
        create_time_ms: Date.now(),
        item_list: [{ type: 3, voice_item: { text: "voice text" } }],
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("getupdates")) {
          callCount++;
          if (callCount === 1) return emptyRes();
          if (callCount === 2) {
            return {
              ok: true,
              json: async () => ({
                ret: 0,
                msgs: [voiceMsg],
                get_updates_buf: "buf3",
              }),
            };
          }
          await channel.stop();
          return emptyRes();
        }
        return { ok: true, json: async () => ({}) };
      });

      await channel.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));

      expect(received[0].text).toBe("voice text");
    });

    it("skips messages with no extractable text", async () => {
      let callCount = 0;
      const imageMsg = {
        message_type: 1,
        from_user_id: "user3",
        context_token: "ctx-img",
        create_time_ms: Date.now(),
        item_list: [{ type: 2 }], // image, no text
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("getupdates")) {
          callCount++;
          if (callCount === 1) return emptyRes();
          if (callCount === 2) {
            return {
              ok: true,
              json: async () => ({
                ret: 0,
                msgs: [imageMsg],
                get_updates_buf: "buf4",
              }),
            };
          }
          await channel.stop();
          return emptyRes();
        }
        return { ok: true, json: async () => ({}) };
      });

      await channel.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(received).toHaveLength(0);
    });
  });

  describe("sendReply", () => {
    it("sends message with stored context_token", async () => {
      let callCount = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("getupdates")) {
          callCount++;
          if (callCount === 1) return emptyRes();
          if (callCount === 2) {
            return {
              ok: true,
              json: async () => ({
                ret: 0,
                msgs: [makeWxMsg("user1", "hi", "tok-123")],
                get_updates_buf: "buf5",
              }),
            };
          }
          await channel.stop();
          return emptyRes();
        }
        if (url.includes("sendmessage")) {
          return { ok: true, json: async () => ({ ret: 0 }) };
        }
        return { ok: true, json: async () => ({}) };
      });

      await channel.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));

      await channel.sendReply("user1", "reply text");

      const sendCall = fetchMock.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("sendmessage"),
      );
      expect(sendCall).toBeDefined();

      const body = JSON.parse((sendCall![1] as { body: string }).body);
      expect(body.msg.to_user_id).toBe("user1");
      expect(body.msg.context_token).toBe("tok-123");
      expect(body.msg.item_list[0].text_item.text).toBe("reply text");
    });

    it("logs error when no context_token available", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await channel.sendReply("unknown-user", "hello");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("No context_token"),
      );
      expect(fetchMock).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it("chunks long text", async () => {
      let callCount = 0;
      const sendBodies: unknown[] = [];

      fetchMock.mockImplementation(async (url: string, opts?: { body?: string }) => {
        if (url.includes("getupdates")) {
          callCount++;
          if (callCount === 1) return emptyRes();
          if (callCount === 2) {
            return {
              ok: true,
              json: async () => ({
                ret: 0,
                msgs: [makeWxMsg("user1", "hi")],
                get_updates_buf: "buf6",
              }),
            };
          }
          await channel.stop();
          return emptyRes();
        }
        if (url.includes("sendmessage")) {
          if (opts?.body) sendBodies.push(JSON.parse(opts.body));
          return { ok: true, json: async () => ({ ret: 0 }) };
        }
        return { ok: true, json: async () => ({}) };
      });

      await channel.start();
      await vi.waitFor(() => expect(received).toHaveLength(1));

      const longText = "a".repeat(2500);
      await channel.sendReply("user1", longText);

      expect(sendBodies).toHaveLength(2);
    });
  });

  describe("sendTyping", () => {
    it("is a no-op", async () => {
      await channel.sendTyping("user1");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("start", () => {
    it("validates connectivity before polling", async () => {
      fetchMock.mockImplementation(async () => emptyRes());

      await channel.start();
      await channel.stop();

      // First call is the validation call from start()
      expect(fetchMock).toHaveBeenCalled();
      const firstUrl = fetchMock.mock.calls[0][0] as string;
      expect(firstUrl).toContain("getupdates");
    });

    it("throws on invalid token", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 });

      await expect(channel.start()).rejects.toThrow("HTTP 401");
    });

    it("sends correct auth headers", async () => {
      fetchMock.mockImplementation(async () => emptyRes());

      await channel.start();
      await channel.stop();

      const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers.AuthorizationType).toBe("ilink_bot_token");
      expect(headers["X-WECHAT-UIN"]).toBeDefined();
    });
  });
});
