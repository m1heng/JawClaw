import { Bot } from "grammy";
import type { Channel, ChannelMessage } from "./channel.js";
import { chunkText } from "./channel.js";
import type { ChannelExtension } from "./extension.js";

const TG_TEXT_LIMIT = 4096;

export class TelegramChannel implements Channel {
  channelName = "telegram";
  private bot: Bot;
  private handler?: (msg: ChannelMessage) => Promise<void>;

  constructor(token: string) {
    this.bot = new Bot(token);

    this.bot.on("message:text", async (ctx) => {
      if (!this.handler) return;
      if (!ctx.message?.text) return;

      await this.handler({
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
        senderId: String(ctx.from.id),
        senderName:
          ctx.from.first_name +
          (ctx.from.last_name ? ` ${ctx.from.last_name}` : ""),
        channel: this.channelName,
      });
    });
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    console.log("Telegram bot starting (polling)...");
    // Validate token by calling getMe before starting polling
    await this.bot.init();
    console.log(`Telegram bot authenticated as @${this.bot.botInfo.username}`);
    // bot.start() runs forever (polling loop) — don't await it,
    // but catch errors so they don't become unhandled rejections
    this.bot.start({
      onStart: () => console.log("Telegram bot polling started."),
    }).catch((err) => {
      console.error("Telegram polling error:", err);
      process.exit(1);
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendReply(chatId: string, text: string): Promise<void> {
    const chunks = chunkText(text, TG_TEXT_LIMIT);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(Number(chatId), chunk);
      } catch (err) {
        console.error(`Failed to send reply to ${chatId}:`, err);
        break; // Don't keep sending if one fails
      }
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), "typing");
    } catch {
      // Typing indicator failure is non-critical
    }
  }
}

export const telegramExtension: ChannelExtension = {
  type: "channel",
  name: "telegram",
  label: "Telegram",
  configFields: [
    { key: "token", label: "Bot Token", placeholder: "123456:ABC-DEF...", required: true },
  ],
  create: (c) => new TelegramChannel(c.token),
};
