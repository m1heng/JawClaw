import { Bot } from "grammy";
import type { Channel, ChannelMessage } from "./channel.js";

export class TelegramChannel implements Channel {
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
    try {
      await this.bot.api.sendMessage(Number(chatId), text);
    } catch (err) {
      console.error(`Failed to send reply to ${chatId}:`, err);
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
