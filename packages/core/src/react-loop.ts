import type { ChatSession } from "./chat-session.js";
import type { MessageQueue } from "./message-queue.js";
import type { AgentConfig, ToolCall, ToolDefinition } from "./types.js";
import type { LLMClient, LLMMessage, LLMResponse, LLMUsage } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import type { Shell } from "./providers/shell.js";
import { executeToolsConcurrently } from "./tool-executor.js";
import {
  estimateTokens,
  snipOldMessages,
  collapseFailedGroups,
  compactHistoryWithMemory,
} from "./context.js";
import { microcompactToolResults } from "./microcompact.js";

export type ReactLoopParams = {
  session: ChatSession;
  queue: MessageQueue;
  config: AgentConfig;
  llm: LLMClient;
  tools: ToolRegistry;
  onAssistantMessage?: (content: string) => void;
  onUsage?: (usage: LLMUsage) => void;
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

    // Build messages for LLM with 5-layer compression pipeline
    const history = await session.readAll();
    const maxContextTokens = config.maxContextTokens ?? 100_000;

    // Estimate baseline overhead (system prompt + tool definitions)
    const systemTokens = estimateTokens(config.systemPrompt);
    const toolsOverhead = config.tools?.length
      ? estimateTokens(JSON.stringify(config.tools))
      : 0;
    const availableBudget = maxContextTokens - systemTokens - toolsOverhead;

    // L1: Tool Result Budget — already applied at execution time (tool-executor)
    // L2: Snip — drop ancient history by message count
    const snipped = snipOldMessages(history);
    // L3: Microcompact — truncate old tool results
    const microcompacted = microcompactToolResults(snipped);
    // L4: Collapse — fold consecutive failed tool-call groups
    const collapsed = collapseFailedGroups(microcompacted);
    // L5: Full compact — token budget + session memory
    const { kept, trimmedCount, sessionMemory } = await compactHistoryWithMemory(
      collapsed, availableBudget,
      { sessionMemoryPath: params.sessionMemoryPath, shell: params.shell },
    );
    const compacted = kept;

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

    // Call LLM with error recovery
    const response = await callLLMWithRecovery(llm, {
      model: config.model,
      messages,
      tools: config.tools,
    });

    // Report usage
    if (response.usage) params.onUsage?.(response.usage);

    // Handle tool calls
    if (response.toolCalls.length > 0) {
      // Append assistant message with tool_calls metadata + usage
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
          ...(response.usage ? { usage: response.usage } : {}),
        },
      });

      // Execute tools (parallel for read-only, serial for exclusive)
      const results = await executeToolsConcurrently(response.toolCalls, tools);
      for (let i = 0; i < response.toolCalls.length; i++) {
        await session.append({
          ts: new Date().toISOString(),
          role: "tool",
          content: results[i],
          meta: {
            tool_call_id: response.toolCalls[i].id,
            tool_name: response.toolCalls[i].name,
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
      ...(response.usage ? { meta: { usage: response.usage } } : {}),
    });
    onAssistantMessage?.(text);
    return text;
  }

  return "Max turns reached.";
}

// ── LLM Error Recovery ────────────────────────────────────────

type LLMErrorType = "prompt_too_long" | "rate_limit" | "unknown";

function classifyError(err: unknown): LLMErrorType {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("context_length") ||
    lower.includes("prompt_too_long") ||
    (lower.includes("max") && lower.includes("token") && lower.includes("limit"))
  ) {
    return "prompt_too_long";
  }
  if (
    lower.includes("rate_limit") ||
    lower.includes("429") ||
    lower.includes("overloaded") ||
    lower.includes("503")
  ) {
    return "rate_limit";
  }
  return "unknown";
}

const MAX_LLM_RETRIES = 3;

async function callLLMWithRecovery(
  llm: LLMClient,
  params: { model: string; messages: LLMMessage[]; tools?: ToolDefinition[] },
): Promise<LLMResponse> {
  let retries = 0;
  let currentMessages = params.messages;

  while (retries < MAX_LLM_RETRIES) {
    try {
      return await llm.createCompletion({
        ...params,
        messages: currentMessages,
      });
    } catch (err) {
      retries++;
      const errorType = classifyError(err);

      if (errorType === "rate_limit" && retries < MAX_LLM_RETRIES) {
        await sleep(1000 * Math.pow(2, retries - 1));
        continue;
      }

      if (errorType === "prompt_too_long" && retries < MAX_LLM_RETRIES) {
        // Emergency: keep system prompt + last 50% of conversation.
        // Find a safe cut point that doesn't split tool-call groups:
        // never start with an orphaned "tool" message.
        const half = Math.floor(currentMessages.length / 2);
        let cutIdx = Math.max(half, 1);
        while (cutIdx < currentMessages.length && currentMessages[cutIdx].role === "tool") {
          cutIdx++;
        }
        currentMessages = [
          currentMessages[0],
          {
            role: "system" as const,
            content: "[Emergency context reduction: older messages dropped due to token limit]",
          },
          ...currentMessages.slice(cutIdx),
        ];
        continue;
      }

      throw err;
    }
  }
  throw new Error("Max LLM retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
