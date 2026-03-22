/** Split text into chunks that fit within a char limit, preferring paragraph breaks. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

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

export type ChannelMessage = {
  chatId: string;
  text: string;
  senderId: string;
  senderName?: string;
  channel: string;
};

export interface Channel {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
  sendReply(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}
