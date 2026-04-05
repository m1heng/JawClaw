import { join } from "node:path";
import type { ChatMessage } from "./types.js";
import type { Shell } from "./providers/shell.js";

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

/** Group messages into atomic units: assistant+tool_calls+tool_results stay together. */
export function groupIntoUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.meta?.tool_calls) {
      const group: ChatMessage[] = [msg];
      i++;
      while (i < messages.length && messages[i].role === "tool") {
        group.push(messages[i]);
        i++;
      }
      units.push(group);
    } else {
      units.push([msg]);
      i++;
    }
  }
  return units;
}

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
  const units = groupIntoUnits(history);

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

/**
 * Enhanced compaction that reads session memory when messages are dropped.
 * Falls back to plain compaction if no session memory exists.
 */
export async function compactHistoryWithMemory(
  history: ChatMessage[],
  maxTokens: number,
  opts?: { sessionMemoryPath?: string; shell?: Shell },
): Promise<{
  kept: ChatMessage[];
  trimmedCount: number;
  sessionMemory?: string;
}> {
  const { kept, trimmedCount } = compactHistory(history, maxTokens);

  if (trimmedCount > 0 && opts?.sessionMemoryPath && opts?.shell) {
    try {
      const memory = await opts.shell.readFile(opts.sessionMemoryPath);
      if (memory.trim()) {
        return { kept, trimmedCount, sessionMemory: memory };
      }
    } catch {
      // No session memory file — fall through
    }
  }

  return { kept, trimmedCount };
}

// ── Snip compact (message-count based) ──────────────────────────

/**
 * Drop ancient messages when total count exceeds threshold.
 * Keeps the last ~80% of atomic units. Does NOT mutate input.
 *
 * This is a coarse pre-filter for extremely long histories,
 * NOT a substitute for token-based compaction. The default threshold
 * is intentionally high (200) to avoid dropping messages that still
 * fit within the token budget.
 */
export function snipOldMessages(
  messages: ChatMessage[],
  maxMessages: number = 200,
): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;

  const units = groupIntoUnits(messages);
  const targetCount = Math.ceil(units.length * 0.8);
  const cutoff = units.length - targetCount;

  return units.slice(cutoff).flat();
}

// ── Context collapse (fold consecutive failed groups) ───────────

/**
 * Check if a tool result indicates an explicit failure or empty search.
 * Does NOT treat empty string as failure — commands like mkdir/touch/git add
 * succeed silently and return empty stdout via formatExec.
 */
function isFailedResult(content: string): boolean {
  const c = content.trim();
  return (
    c === "(no matches)" ||
    c === "(no files found)" ||
    c.startsWith("Error") ||
    c.startsWith("exit code")
  );
}

/**
 * Fold runs of ≥3 consecutive failed tool-call groups into a single
 * summary message. Does NOT mutate input.
 *
 * When `boundaryIndex` is set, only groups whose first message index
 * is before the boundary are eligible for collapse. Groups at or after
 * the boundary (the "recent zone") are preserved intact for cache safety.
 *
 * When `processedCount` is set, the first `processedCount` INPUT messages
 * are passed through unchanged (they were already collapsed in a previous
 * turn). Only new messages beyond that point are evaluated for collapse.
 *
 * Returns `{ messages, processedCount }` where processedCount tracks how
 * many INPUT messages have been processed so far. This value is always
 * measured against the input array, not the (potentially shorter) output,
 * so it stays correct across turns even when messages are collapsed.
 */
export function collapseFailedGroups(
  messages: ChatMessage[],
  opts?: { boundaryIndex?: number; processedCount?: number },
): { messages: ChatMessage[]; processedCount: number } {
  const boundary = opts?.boundaryIndex;
  const alreadyProcessed = opts?.processedCount ?? 0;

  // Messages already processed in a previous turn — pass through verbatim.
  // These may be fewer than alreadyProcessed if earlier turns collapsed some,
  // so clamp to the actual array length.
  const frozenEnd = Math.min(alreadyProcessed, messages.length);
  const frozen = messages.slice(0, frozenEnd);
  const rest = messages.slice(frozenEnd);

  const units = groupIntoUnits(rest);
  const result: ChatMessage[][] = [];
  let failedRun: ChatMessage[][] = [];
  // messageOffset tracks position in the FULL input messages array
  let messageOffset = frozenEnd;

  const isFailedGroup = (unit: ChatMessage[]): boolean => {
    if (unit.length < 2 || unit[0].role !== "assistant" || !unit[0].meta?.tool_calls) {
      return false;
    }
    const toolResults = unit.filter((m) => m.role === "tool");
    return toolResults.length > 0 && toolResults.every((m) => isFailedResult(m.content));
  };

  const flushFailed = () => {
    if (failedRun.length < 3) {
      result.push(...failedRun);
    } else {
      const toolNames = failedRun.flatMap((u) => {
        const calls = u[0].meta?.tool_calls as Array<{ name: string }> | undefined;
        return calls?.map((tc) => tc.name) ?? [];
      });
      const uniqueTools = [...new Set(toolNames)].join(", ");
      result.push([{
        ts: failedRun[0][0].ts,
        role: "user" as const,
        content: `[${failedRun.length} tool-call groups collapsed: all returned errors/empty. Tools used: ${uniqueTools}]`,
      }]);
    }
    failedRun = [];
  };

  for (const unit of units) {
    // Past the boundary — flush any pending failures and pass through uncollapsed
    if (boundary !== undefined && messageOffset >= boundary) {
      flushFailed();
      result.push(unit);
      messageOffset += unit.length;
      continue;
    }

    if (isFailedGroup(unit)) {
      failedRun.push(unit);
    } else {
      flushFailed();
      result.push(unit);
    }
    messageOffset += unit.length;
  }
  flushFailed();

  const collapsed = [...frozen, ...result.flat()];
  // processedCount tracks INPUT messages consumed, not output length
  return { messages: collapsed, processedCount: messageOffset };
}

/** Count the number of tool-call groups in a message array. */
export function countToolGroups(messages: ChatMessage[]): number {
  const units = groupIntoUnits(messages);
  return units.filter(
    (u) => u.length > 1 && u[0].role === "assistant" && u[0].meta?.tool_calls,
  ).length;
}

/**
 * Map a microcompact watermark (tool-group count) to a message index.
 * Returns the index of the first message AFTER the watermark-th tool group,
 * i.e. the start of the "recent zone" that should be preserved for cache safety.
 */
export function watermarkToMessageIndex(
  messages: ChatMessage[],
  watermark: number,
): number {
  if (watermark <= 0) return 0;
  const units = groupIntoUnits(messages);
  let toolGroupsSeen = 0;
  let messageOffset = 0;
  for (const unit of units) {
    const isToolGroup =
      unit.length > 1 && unit[0].role === "assistant" && unit[0].meta?.tool_calls;
    if (isToolGroup) {
      toolGroupsSeen++;
      if (toolGroupsSeen === watermark) {
        return messageOffset + unit.length;
      }
    }
    messageOffset += unit.length;
  }
  return messageOffset;
}

// ── Bootstrap file injection ─────────────────────────────────────

const DEFAULT_MAX_PER_FILE = 8_000;
const DEFAULT_MAX_TOTAL = 32_000;

export type BootstrapFile = {
  label: string;
  path: string;
};

/** Truncate content: keep 70% head + 20% tail, discard middle. */
function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.2);
  return (
    content.slice(0, headSize) +
    "\n\n[... truncated, use read_file for full content ...]\n\n" +
    content.slice(-tailSize)
  );
}

/**
 * Build a system prompt by appending bootstrap files.
 *
 * Files that don't exist are silently skipped.
 * Per-file and total char budgets prevent context bloat.
 * Large files are truncated with 70% head + 20% tail strategy.
 */
export async function buildSystemPrompt(
  basePrompt: string,
  files: BootstrapFile[],
  shell: Shell,
  opts?: { maxPerFile?: number; maxTotal?: number },
): Promise<string> {
  const maxPerFile = opts?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  let remaining = opts?.maxTotal ?? DEFAULT_MAX_TOTAL;

  const sections: string[] = [];

  for (const file of files) {
    if (remaining <= 0) break;
    try {
      const raw = await shell.readFile(file.path);
      if (!raw.trim()) continue;

      const budget = Math.min(maxPerFile, remaining);
      const content = truncateContent(raw, budget);
      remaining -= content.length;

      sections.push(`## ${file.label}\n\n${content}`);
    } catch {
      // File doesn't exist — skip
    }
  }

  if (sections.length === 0) return basePrompt;
  return basePrompt + "\n\n---\n\n" + sections.join("\n\n");
}

/** Stable bootstrap files for Mouth (identity — rarely changes, cacheable). */
export function mouthStableBootstrapFiles(memoryRoot: string): BootstrapFile[] {
  const wsRoot = join(memoryRoot, "..");
  return [
    { label: "SOUL.md", path: join(wsRoot, "SOUL.md") },
    { label: "INSTRUCTIONS.md", path: join(wsRoot, "INSTRUCTIONS.md") },
  ];
}

/** Dynamic bootstrap files for Mouth (memory — changes frequently). */
export function mouthDynamicBootstrapFiles(memoryRoot: string): BootstrapFile[] {
  return [
    { label: "MEMORY.md", path: join(memoryRoot, "MEMORY.md") },
    { label: "Session Memory", path: join(memoryRoot, "session-memory.md") },
  ];
}

/** @deprecated Use mouthStableBootstrapFiles + mouthDynamicBootstrapFiles. */
export function mouthBootstrapFiles(memoryRoot: string): BootstrapFile[] {
  return [...mouthStableBootstrapFiles(memoryRoot), ...mouthDynamicBootstrapFiles(memoryRoot)];
}

/** Standard bootstrap files for Hand (identity only, no memory). */
export function handBootstrapFiles(memoryRoot: string): BootstrapFile[] {
  const wsRoot = join(memoryRoot, "..");
  return [
    { label: "SOUL.md", path: join(wsRoot, "SOUL.md") },
    { label: "INSTRUCTIONS.md", path: join(wsRoot, "INSTRUCTIONS.md") },
  ];
}
