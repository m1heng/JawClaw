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
    this.bot.start({
      onStart: () => console.log("Telegram bot is running."),
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
