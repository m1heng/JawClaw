import type { Shell } from "./providers/shell.js";
import type { ChatMessage } from "./types.js";

export class ChatSession {
  constructor(
    public readonly filePath: string,
    private readonly shell: Shell,
  ) {}

  async append(msg: ChatMessage): Promise<void> {
    await this.shell.appendFile(this.filePath, JSON.stringify(msg) + "\n");
  }

  async readAll(): Promise<ChatMessage[]> {
    try {
      const data = await this.shell.readFile(this.filePath);
      return data
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ChatMessage);
    } catch {
      return [];
    }
  }

  async readTail(n: number): Promise<ChatMessage[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }
}
