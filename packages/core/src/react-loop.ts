import type { ChatSession } from "./chat-session.js";
import type { MessageQueue } from "./message-queue.js";
import type { AgentConfig } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import { executeTool } from "./tool-executor.js";

export type ReactLoopParams = {
  session: ChatSession;
  queue: MessageQueue;
  config: AgentConfig;
  llm: LLMClient;
  tools: ToolRegistry;
  onAssistantMessage?: (content: string) => void;
  abortSignal?: AbortSignal;
};

export async function runReactLoop(params: ReactLoopParams): Promise<string> {
  const { session, queue, config, llm, tools, onAssistantMessage, abortSignal } = params;
  const maxTurns = config.maxTurns ?? 20;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (abortSignal?.aborted) break;

    // Check message queue and inject any new messages
    const queued = queue.drain();
    for (const msg of queued) {
      const chatMsg = { ts: msg.ts, role: "user" as const, content: msg.content };
      await session.append(chatMsg);
    }

    // Build messages for LLM, preserving tool_calls on assistant messages
    const history = await session.readAll();
    const messages: LLMMessage[] = [
      { role: "system", content: config.systemPrompt },
      ...history.map((m): LLMMessage => {
        if (m.role === "tool") {
          return {
            role: "tool",
            content: m.content,
            tool_call_id: m.meta?.tool_call_id as string,
          };
        }
        if (m.role === "assistant" && m.meta?.tool_calls) {
          const toolCalls = m.meta.tool_calls as Array<{
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          }>;
          return {
            role: "assistant",
            content: m.content,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          };
        }
        return { role: m.role as "user" | "system", content: m.content };
      }),
    ];

    // Call LLM
    const response = await llm.createCompletion({
      model: config.model,
      messages,
      tools: config.tools,
    });

    // Handle tool calls
    if (response.toolCalls.length > 0) {
      // Append assistant message with tool_calls metadata
      await session.append({
        ts: new Date().toISOString(),
        role: "assistant",
        content: response.content ?? "",
        meta: {
          tool_calls: response.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        },
      });

      // Execute each tool and append results
      for (const toolCall of response.toolCalls) {
        const result = await executeTool(toolCall, tools);
        await session.append({
          ts: new Date().toISOString(),
          role: "tool",
          content: result,
          meta: {
            tool_call_id: toolCall.id,
            tool_name: toolCall.name,
          },
        });
      }

      continue; // Loop again to let LLM process tool results
    }

    // Text-only response — done
    const text = response.content ?? "";
    await session.append({
      ts: new Date().toISOString(),
      role: "assistant",
      content: text,
    });
    onAssistantMessage?.(text);
    return text;
  }

  return "Max turns reached.";
}
