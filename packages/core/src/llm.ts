import OpenAI from "openai";
import type { ToolDefinition, ToolCall } from "./types.js";

export type LLMResponse = {
  content: string | null;
  toolCalls: ToolCall[];
};

// Message types that can be sent to the LLM
export type LLMMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; content: string; tool_call_id: string };

export type LLMClient = {
  createCompletion(params: {
    model: string;
    messages: LLMMessage[];
    tools?: ToolDefinition[];
  }): Promise<LLMResponse>;
};

export function createLLMClient(apiKey: string, baseUrl?: string): LLMClient {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  return {
    async createCompletion({ model, messages, tools }) {
      const openaiTools = tools?.length
        ? tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined;

      const response = await client.chat.completions.create({
        model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        tools: openaiTools,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from LLM");

      const toolCalls: ToolCall[] =
        choice.message.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        })) ?? [];

      return {
        content: choice.message.content,
        toolCalls,
      };
    },
  };
}
