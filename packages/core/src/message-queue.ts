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

  /** Drain up to `max` items. Default: drain all. */
  drain(max?: number): QueueMessage[] {
    if (max === undefined || max >= this.items.length) {
      return this.items.splice(0);
    }
    return this.items.splice(0, max);
  }

  check(): QueueMessage | null {
    return this.items.shift() ?? null;
  }

  get length(): number {
    return this.items.length;
  }
}
