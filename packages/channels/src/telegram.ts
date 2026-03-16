import { Bot } from "grammy";
import type { Channel, ChannelMessage } from "./channel.js";

const TG_TEXT_LIMIT = 4096;

/** Split text into chunks that fit within a char limit, preferring paragraph breaks. */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find the best break point within the limit
    let breakAt = -1;

    // Prefer double newline (paragraph break)
    const paraIdx = remaining.lastIndexOf("\n\n", limit);
    if (paraIdx > limit * 0.3) {
      breakAt = paraIdx;
    }

    // Fallback: single newline
    if (breakAt === -1) {
      const nlIdx = remaining.lastIndexOf("\n", limit);
      if (nlIdx > limit * 0.3) {
        breakAt = nlIdx;
      }
    }

    // Last resort: hard break at limit
    if (breakAt === -1) {
      breakAt = limit;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n+/, "");
  }

  return chunks;
}

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
