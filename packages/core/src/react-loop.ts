import type { ChatSession } from "./chat-session.js";
import type { MessageQueue } from "./message-queue.js";
import type { AgentConfig, ToolCall } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import type { Shell } from "./providers/shell.js";
import { executeTool } from "./tool-executor.js";
import { estimateTokens, compactHistoryWithMemory } from "./context.js";
import { microcompactToolResults } from "./microcompact.js";

export type ReactLoopParams = {
  session: ChatSession;
  queue: MessageQueue;
  config: AgentConfig;
  llm: LLMClient;
  tools: ToolRegistry;
  onAssistantMessage?: (content: string) => void;
  onTurn?: () => void;
  abortSignal?: AbortSignal;
  sessionMemoryPath?: string;
  shell?: Shell;
};

export async function runReactLoop(params: ReactLoopParams): Promise<string> {
  const { session, queue, config, llm, tools, onAssistantMessage, onTurn, abortSignal } = params;
  const maxTurns = config.maxTurns ?? 20;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (abortSignal?.aborted) break;
    onTurn?.();

    // Check message queue and inject any new messages
    const queued = queue.drain();
    for (const msg of queued) {
      const chatMsg = { ts: msg.ts, role: "user" as const, content: msg.content, ...(msg.meta ? { meta: msg.meta } : {}) };
      await session.append(chatMsg);
    }

    // Build messages for LLM with compaction if needed
    const history = await session.readAll();
    const maxContextTokens = config.maxContextTokens ?? 100_000;

    // Estimate baseline overhead (system prompt + tool definitions)
    const systemTokens = estimateTokens(config.systemPrompt);
    const toolsOverhead = config.tools?.length
      ? estimateTokens(JSON.stringify(config.tools))
      : 0;
    const availableBudget = maxContextTokens - systemTokens - toolsOverhead;

    const { kept, trimmedCount, sessionMemory } = await compactHistoryWithMemory(
      history, availableBudget,
      { sessionMemoryPath: params.sessionMemoryPath, shell: params.shell },
    );
    const compacted = microcompactToolResults(kept);

    const messages: LLMMessage[] = [
      { role: "system", content: config.systemPrompt },
    ];

    if (trimmedCount > 0) {
      // Session memory content is already in the system prompt via mouthBootstrapFiles.
      // Here we only note that compaction happened; reference the existing injection.
      const hint = sessionMemory
        ? " Session memory with key context is included in the system prompt above."
        : ` Use read_file on "${session.filePath}" for complete history.`;
      messages.push({
        role: "system",
        content: `[${trimmedCount} earlier messages omitted due to context limits.${hint}]`,
      });
    }

    const toMessage = (m: (typeof compacted)[number]): LLMMessage => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
          toolCallId: m.meta?.tool_call_id as string,
        };
      }
      if (m.role === "assistant" && m.meta?.tool_calls) {
        return {
          role: "assistant",
          content: m.content,
          toolCalls: m.meta.tool_calls as ToolCall[],
        };
      }
      // Prepend channel metadata to user messages so the LLM sees chat_id/sender
      if (m.role === "user" && m.meta?.chat_id) {
        const parts = [`[chat_id=${m.meta.chat_id}`];
        if (m.meta.sender_name) parts.push(`sender=${m.meta.sender_name}`);
        if (m.meta.channel) parts.push(`channel=${m.meta.channel}`);
        const prefix = parts.join(" ") + "]\n";
        return { role: "user", content: prefix + m.content };
      }
      return { role: m.role as "user" | "system", content: m.content };
    };

    messages.push(...compacted.map(toMessage));

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
