import type { LLMClient, LLMResponse } from "../../llm.js";

type QueuedItem =
  | { type: "response"; response: LLMResponse }
  | { type: "error"; error: Error };

/**
 * Mock LLM client that returns pre-configured responses in order.
 */
export class MockLLM implements LLMClient {
  private queue: QueuedItem[] = [];
  calls: Array<{ model: string; messageCount: number }> = [];

  /** Queue a text-only response. */
  addTextResponse(text: string, stopReason?: string): this {
    this.queue.push({
      type: "response",
      response: { content: text, toolCalls: [], stopReason: stopReason ?? "end_turn" },
    });
    return this;
  }

  /** Queue a tool-call response. */
  addToolCallResponse(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    content?: string,
  ): this {
    this.queue.push({
      type: "response",
      response: { content: content ?? null, toolCalls, stopReason: "tool_use" },
    });
    return this;
  }

  /** Queue an error that createCompletion will throw. */
  addErrorResponse(error: Error): this {
    this.queue.push({ type: "error", error });
    return this;
  }

  async createCompletion(params: {
    model: string;
    messages: unknown[];
    tools?: unknown[];
  }): Promise<LLMResponse> {
    this.calls.push({ model: params.model, messageCount: params.messages.length });
    const item = this.queue.shift();
    if (!item) throw new Error("MockLLM: no more responses queued");
    if (item.type === "error") throw item.error;
    return item.response;
  }
}
