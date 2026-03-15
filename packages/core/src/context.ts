import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./types.js";

// ── Token estimation ─────────────────────────────────────────────

/** Estimate token count from a string (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a ChatMessage including meta overhead. */
export function estimateMessageTokens(msg: ChatMessage): number {
  let total = estimateTokens(msg.content);
  if (msg.meta) {
    total += estimateTokens(JSON.stringify(msg.meta));
  }
  return total + 4; // role label + separators
}

// ── Context compaction ───────────────────────────────────────────

/**
 * Compact a ChatMessage[] history to fit within a token budget.
 *
 * Strategy: walk from the end backward, accumulating tokens.
 * Tool-call groups (assistant with tool_calls + subsequent tool messages)
 * are atomic — kept or dropped together.
 *
 * Does NOT mutate the input or touch the session file (SSOT).
 */
export function compactHistory(
  history: ChatMessage[],
  maxTokens: number,
): { kept: ChatMessage[]; trimmedCount: number } {
  // Group messages into atomic units
  const units: ChatMessage[][] = [];
  let i = 0;
  while (i < history.length) {
    const msg = history[i];
    if (msg.role === "assistant" && msg.meta?.tool_calls) {
      const group: ChatMessage[] = [msg];
      i++;
      while (i < history.length && history[i].role === "tool") {
        group.push(history[i]);
        i++;
      }
      units.push(group);
    } else {
      units.push([msg]);
      i++;
    }
  }

  // Walk from the end, keep units that fit (always keep at least the last unit)
  let budget = maxTokens;
  let cutoff = units.length;

  for (let u = units.length - 1; u >= 0; u--) {
    const unitTokens = units[u].reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );
    if (budget - unitTokens < 0 && u < units.length - 1) {
      cutoff = u + 1;
      break;
    }
    budget -= unitTokens;
    cutoff = u;
  }

  const kept = units.slice(cutoff).flat();
  const trimmedCount = units.slice(0, cutoff).flat().length;
  return { kept, trimmedCount };
}

// ── System prompt building ───────────────────────────────────────

const MAX_MEMORY_INJECTION = 4000;
const TRUNCATION_MARKER =
  "\n\n[... MEMORY.md truncated, use read_file for full content ...]";

/**
 * Build a system prompt by appending MEMORY.md content.
 * Returns base prompt unchanged if MEMORY.md is missing or empty.
 */
export async function buildSystemPrompt(
  basePrompt: string,
  memoryRoot: string,
): Promise<string> {
  try {
    let content = await readFile(join(memoryRoot, "MEMORY.md"), "utf-8");
    if (!content.trim()) return basePrompt;

    if (content.length > MAX_MEMORY_INJECTION) {
      content = content.slice(0, MAX_MEMORY_INJECTION) + TRUNCATION_MARKER;
    }

    return (
      basePrompt +
      "\n\n---\n\n## Shared Memory (MEMORY.md)\n\n" +
      content
    );
  } catch {
    return basePrompt;
  }
}
