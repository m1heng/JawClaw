import type { ToolDefinition, ToolCall } from "./types.js";

export type LLMResponse = {
  content: string | null;
  toolCalls: ToolCall[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "content_filter" | string;
};

export type LLMMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export type LLMClient = {
  createCompletion(params: {
    model: string;
    messages: LLMMessage[];
    tools?: ToolDefinition[];
  }): Promise<LLMResponse>;
};
