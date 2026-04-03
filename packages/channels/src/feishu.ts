import * as lark from "@larksuiteoapi/node-sdk";
import type { Channel, ChannelMessage } from "./channel.js";
import { chunkText } from "./channel.js";
import type { ChannelExtension } from "./extension.js";

const FEISHU_TEXT_LIMIT = 4000;

export class FeishuChannel implements Channel {
  channelName = "feishu";
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private dispatcher: lark.EventDispatcher;
  private handler?: (msg: ChannelMessage) => Promise<void>;

  constructor(appId: string, appSecret: string) {
    this.client = new lark.Client({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.error,
    });

    this.dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        await this.handleInbound(data as Record<string, unknown>);
      },
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.error,
    });
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    console.log("Feishu bot starting (WebSocket)...");
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
    console.log("Feishu bot connected.");
  }

  async stop(): Promise<void> {
    this.wsClient.close();
  }

  async sendReply(chatId: string, text: string): Promise<void> {
    const chunks = chunkText(text, FEISHU_TEXT_LIMIT);
    for (const chunk of chunks) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          },
        });
      } catch (err) {
        console.error(`[feishu] Failed to send to ${chatId}:`, err);
        break;
      }
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu doesn't support typing indicators
  }

  private async handleInbound(data: Record<string, unknown>): Promise<void> {
    if (!this.handler) return;

    const sender = data.sender as Record<string, unknown> | undefined;
    const message = data.message as Record<string, unknown> | undefined;
    if (!sender || !message) return;

    // Skip bot messages to avoid self-loops
    if (sender.sender_type === "app") return;

    const senderIdObj = sender.sender_id as
      | Record<string, string>
      | undefined;
    const chatId = message.chat_id as string;
    const senderId = senderIdObj?.open_id || "unknown";
    const messageType = message.message_type as string;

    let text = "";
    try {
      const content = JSON.parse(message.content as string);
      if (messageType === "text") {
        text = content.text || "";
      } else if (messageType === "post") {
        text = this.extractPostText(content);
      } else {
        text = `(${messageType} message)`;
      }
    } catch {
      text = (message.content as string) || "";
    }

    if (!text) return;

    // Clean @mention placeholders
    text = text.replace(/@_user_\d+/g, "").trim();

    await this.handler({
      chatId,
      text,
      senderId,
      channel: this.channelName,
    });
  }

  private extractPostText(content: {
    title?: string;
    content?: Array<Array<{ text?: string }>>;
  }): string {
    const lines: string[] = [];
    if (content.title) lines.push(content.title);
    for (const paragraph of content.content || []) {
      const parts: string[] = [];
      for (const element of paragraph || []) {
        if (element.text) parts.push(element.text);
      }
      if (parts.length) lines.push(parts.join(""));
    }
    return lines.join("\n");
  }
}

export const feishuExtension: ChannelExtension = {
  type: "channel",
  name: "feishu",
  label: "Feishu (飞书)",
  configFields: [
    { key: "token", label: "App ID", placeholder: "cli_xxxx", required: true },
    { key: "appSecret", label: "App Secret", required: true },
  ],
  create: (c) => new FeishuChannel(c.token, c.appSecret),
};
