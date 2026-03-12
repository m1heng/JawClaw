export type QueueMessage = {
  content: string;
  from: string;
  ts: string;
};

export class MessageQueue {
  private items: QueueMessage[] = [];

  enqueue(msg: QueueMessage): void {
    this.items.push(msg);
  }

  drain(): QueueMessage[] {
    const all = this.items.splice(0);
    return all;
  }

  check(): QueueMessage | null {
    return this.items.shift() ?? null;
  }

  get length(): number {
    return this.items.length;
  }
}
