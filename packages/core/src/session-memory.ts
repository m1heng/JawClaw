import type { ChatSession } from "./chat-session.js";
import type { LLMClient } from "./llm.js";
import type { Shell } from "./providers/shell.js";
import type { ChatMessage } from "./types.js";
import { join } from "node:path";

export type SessionMemoryConfig = {
  messageThreshold?: number; // min new messages to trigger, default 20
  toolCallThreshold?: number; // min tool calls since last, default 3
};

const EXTRACTION_PROMPT = `Extract structured session memory from the conversation below.
Output ONLY the markdown below, updating each section with relevant information.
If a section has no new information, keep the existing content or write "(none)".
Merge with any existing memory provided — do not discard old information unless it's superseded.

# Session Memory
## Current State
What is the agent currently working on?
## Key Decisions
Important decisions made during this session.
## Files & Functions
Code locations referenced or modified (file paths, function names).
## Errors & Fixes
Problems encountered and how they were resolved.
## User Preferences
Behavioral preferences or patterns observed.`;

/**
 * Build extraction prompt from recent messages and optional existing memory.
 */
export function buildExtractionPrompt(
  messages: ChatMessage[],
  existingMemory?: string,
): string {
  const conversation = messages
    .map((m) => `[${m.role}] ${m.content.slice(0, 500)}`)
    .join("\n");

  let prompt =
    EXTRACTION_PROMPT + "\n\n## Recent Conversation\n" + conversation;
  if (existingMemory) {
    prompt += "\n\n## Existing Memory\n" + existingMemory;
  }
  return prompt;
}

/**
 * Extract structured session memory. Returns null if thresholds not met.
 * Non-blocking: designed to be called fire-and-forget.
 */
export async function extractSessionMemory(params: {
  session: ChatSession;
  llm: LLMClient;
  model: string;
  shell: Shell;
  memoryRoot: string;
  config?: SessionMemoryConfig;
  lastCheckpoint: number;
}): Promise<{ newCheckpoint: number } | null> {
  const { session, llm, model, shell, memoryRoot, config, lastCheckpoint } =
    params;
  const msgThreshold = config?.messageThreshold ?? 20;
  const toolThreshold = config?.toolCallThreshold ?? 3;

  const allMessages = await session.readAll();
  const newMessages = allMessages.slice(lastCheckpoint);

  // Check message threshold
  if (newMessages.length < msgThreshold) return null;

  // Check tool call threshold (count individual tool calls, not just messages)
  const toolCallCount = newMessages.reduce((sum, m) => {
    if (m.role === "assistant" && Array.isArray(m.meta?.tool_calls)) {
      return sum + (m.meta!.tool_calls as unknown[]).length;
    }
    return sum;
  }, 0);
  if (toolCallCount < toolThreshold) return null;

  // Read existing session memory if available
  const memoryPath = join(memoryRoot, "session-memory.md");
  let existingMemory: string | undefined;
  try {
    existingMemory = await shell.readFile(memoryPath);
  } catch {
    // No existing memory
  }

  // Build prompt and call LLM
  const prompt = buildExtractionPrompt(newMessages, existingMemory);
  const response = await llm.createCompletion({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a session memory extractor. Output only the structured markdown.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.content ?? "";
  if (!content.trim()) return null;

  // Write session memory
  await shell.mkdir(memoryRoot);
  await shell.writeFile(memoryPath, content);

  // Write checkpoint
  const checkpointPath = join(memoryRoot, ".session-memory-checkpoint");
  await shell.writeFile(checkpointPath, String(allMessages.length));

  return { newCheckpoint: allMessages.length };
}
