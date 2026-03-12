import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatMessage } from "./types.js";

export class ChatSession {
  constructor(public readonly filePath: string) {}

  async append(msg: ChatMessage): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(msg) + "\n", "utf-8");
  }

  async readAll(): Promise<ChatMessage[]> {
    try {
      const data = await readFile(this.filePath, "utf-8");
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
