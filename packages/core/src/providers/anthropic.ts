import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMMessage } from "../llm.js";
import type { ToolDefinition, ToolCall } from "../types.js";

export function createAnthropicClient(apiKey: string): LLMClient {
  const client = new Anthropic({ apiKey });

  return {
    async createCompletion({ model, messages, tools }) {
      const systemMsg = messages.find((m) => m.role === "system");
      const conversationMsgs = messages.filter((m) => m.role !== "system");

      const anthropicTools = tools?.map(toAnthropicTool);
      const anthropicMessages = toAnthropicMessages(conversationMsgs);

      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemMsg?.content,
        messages: anthropicMessages,
        tools: anthropicTools,
      });

      let content: string | null = null;
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          content = block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
        }
      }

      return { content, toolCalls };
    },
  };
}

function toAnthropicTool(
  t: ToolDefinition,
): Anthropic.Messages.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Messages.Tool.InputSchema,
  };
}

function toAnthropicMessages(
  messages: LLMMessage[],
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      result.push({
        role: "assistant",
        content:
          content.length === 1 && content[0].type === "text"
            ? (content[0] as Anthropic.Messages.TextBlockParam).text
            : content,
      });
    } else if (msg.role === "tool") {
      const toolResultBlock: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content,
      };

      // Merge consecutive tool results into one user message
      const prev = result[result.length - 1];
      if (prev?.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(toolResultBlock);
      } else {
        result.push({ role: "user", content: [toolResultBlock] });
      }
    }
  }

  return result;
}
