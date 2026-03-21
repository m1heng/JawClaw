import type { LLMClient, LLMResponse } from "../../llm.js";

/**
 * Mock LLM client that returns pre-configured responses in order.
 */
export class MockLLM implements LLMClient {
  private responses: LLMResponse[] = [];
  calls: Array<{ model: string; messageCount: number }> = [];

  /** Queue a text-only response. */
  addTextResponse(text: string): this {
    this.responses.push({ content: text, toolCalls: [] });
    return this;
  }

  /** Queue a tool-call response. */
  addToolCallResponse(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    content?: string,
  ): this {
    this.responses.push({ content: content ?? null, toolCalls });
    return this;
  }

  async createCompletion(params: {
    model: string;
    messages: unknown[];
    tools?: unknown[];
  }): Promise<LLMResponse> {
    this.calls.push({ model: params.model, messageCount: params.messages.length });
    const response = this.responses.shift();
    if (!response) throw new Error("MockLLM: no more responses queued");
    return response;
  }
}
