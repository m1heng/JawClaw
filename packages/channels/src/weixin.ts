import type { Channel, ChannelMessage } from "./channel.js";
import { chunkText } from "./channel.js";

const WX_TEXT_LIMIT = 2000;

export class WeixinChannel implements Channel {
  private token: string;
  private baseUrl: string;
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private running = false;
  private syncBuf = "";
  private contextTokens = new Map<string, string>();
  private headers: Record<string, string>;

  constructor(token: string, baseUrl?: string) {
    this.token = token;
    this.baseUrl = (baseUrl || "https://ilinkai.weixin.qq.com").replace(
      /\/$/,
      "",
    );
    this.headers = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
      "X-WECHAT-UIN": Buffer.from(
        crypto.getRandomValues(new Uint8Array(16)),
      ).toString("base64"),
    };
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    console.log("WeChat bot starting (long-poll)...");
    this.running = true;
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async sendReply(chatId: string, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(chatId);
    if (!contextToken) {
      console.error(`[weixin] No context_token for chatId ${chatId}`);
      return;
    }

    const chunks = chunkText(text, WX_TEXT_LIMIT);
    for (const chunk of chunks) {
      try {
        await this.send(chatId, chunk, contextToken);
      } catch (err) {
        console.error(`[weixin] Failed to send to ${chatId}:`, err);
        break;
      }
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // WeChat iLink API doesn't support typing indicators
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;

    while (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify({ get_updates_buf: this.syncBuf }),
          signal: AbortSignal.timeout(40_000),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as {
          ret?: number;
          msgs?: unknown[];
          get_updates_buf?: string;
        };
        if (data.get_updates_buf) this.syncBuf = data.get_updates_buf;

        if (data.msgs?.length) {
          for (const msg of data.msgs) {
            await this.handleInbound(msg as Record<string, unknown>);
          }
        }

        failures = 0;
      } catch (err) {
        failures++;
        const delay = failures >= 3 ? 30_000 : 2_000;
        console.error(`[weixin] Poll error (retry in ${delay / 1000}s):`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async handleInbound(msg: Record<string, unknown>): Promise<void> {
    if (!this.handler) return;
    // Skip bot messages
    if (msg.message_type !== 1) return;

    const userId = msg.from_user_id as string;
    const contextToken = msg.context_token as string;

    if (contextToken) this.contextTokens.set(userId, contextToken);

    // Extract text from item_list
    const items = (msg.item_list as Array<Record<string, unknown>>) || [];
    const texts: string[] = [];
    for (const item of items) {
      if (item.type === 1) {
        const ti = item.text_item as { text?: string } | undefined;
        if (ti?.text) texts.push(ti.text);
      } else if (item.type === 3) {
        const vi = item.voice_item as { text?: string } | undefined;
        if (vi?.text) texts.push(vi.text);
      }
    }

    const text = texts.join("\n");
    if (!text) return;

    await this.handler({
      chatId: userId,
      text,
      senderId: userId,
      channel: "weixin",
    });
  }

  private async send(
    toUserId: string,
    text: string,
    contextToken: string,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        msg: {
          to_user_id: toUserId,
          client_id: crypto.randomUUID(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken,
        },
        base_info: { channel_version: "0.1.0" },
      }),
    });

    if (!res.ok) throw new Error(`sendmessage HTTP ${res.status}`);
  }
}
