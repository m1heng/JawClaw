import OpenAI from "openai";
import type { LLMClient, LLMMessage } from "../llm.js";
import type { ToolDefinition, ToolCall } from "../types.js";

export function createOpenAIClient(
  apiKey: string,
  baseUrl?: string,
): LLMClient {
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  return {
    async createCompletion({ model, messages, tools }) {
      const openaiMessages = messages.map(toOpenAIMessage);

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
        messages: openaiMessages,
        tools: openaiTools,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from LLM");

      const toolCalls: ToolCall[] =
        choice.message.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(
            tc.function.arguments,
          ) as Record<string, unknown>,
        })) ?? [];

      const stopReason = mapFinishReason(choice.finish_reason);
      const usage = response.usage
        ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens }
        : undefined;
      return {
        content: choice.message.content,
        toolCalls,
        stopReason,
        usage,
      };
    },
  };
}

function mapFinishReason(reason: string | null | undefined): string | undefined {
  switch (reason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    case "content_filter": return "content_filter";
    default: return reason ?? undefined;
  }
}

function toOpenAIMessage(
  msg: LLMMessage,
): OpenAI.ChatCompletionMessageParam {
  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content,
      tool_call_id: msg.toolCallId,
    };
  }
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    return {
      role: "assistant",
      content: msg.content,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }
  return {
    role: msg.role as "system" | "user",
    content: msg.content,
  };
}
