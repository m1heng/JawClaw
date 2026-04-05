import type { ChatMessage } from "./types.js";
import { groupIntoUnits } from "./context.js";

export type MicrocompactOptions = {
  keepRecentGroups?: number; // default 3
  maxCharsPerResult?: number; // default 1500 - skip truncation if under this
  headChars?: number; // default 1000
  tailChars?: number; // default 500
  watermark?: number; // previous watermark — ensures monotonic advancement
};

export type MicrocompactResult = {
  messages: ChatMessage[];
  watermark: number;
};

/**
 * Truncate old tool results in-memory. Does NOT mutate input.
 *
 * Uses a monotonically-advancing watermark: tool groups before the watermark
 * are permanently truncated, and the watermark only moves forward.
 * This ensures previously-sent messages are never modified between LLM turns,
 * preserving prefix cache (KV cache).
 */
export function microcompactToolResults(
  messages: ChatMessage[],
  opts?: MicrocompactOptions,
): MicrocompactResult {
  const keepRecent = opts?.keepRecentGroups ?? 3;
  const maxChars = opts?.maxCharsPerResult ?? 1500;
  const head = opts?.headChars ?? 1000;
  const tail = opts?.tailChars ?? 500;
  const prevWatermark = opts?.watermark ?? 0;

  const units = groupIntoUnits(messages);

  const isToolGroup = (unit: ChatMessage[]) =>
    unit.length > 1 && unit[0].role === "assistant" && unit[0].meta?.tool_calls;

  // Count total tool-call groups
  let totalToolGroups = 0;
  for (const unit of units) {
    if (isToolGroup(unit)) totalToolGroups++;
  }

  // Watermark only advances, never decreases
  const newWatermark = Math.max(prevWatermark, Math.max(0, totalToolGroups - keepRecent));

  // Mark groups before the watermark for truncation
  const truncateFlags: boolean[] = new Array(units.length).fill(false);
  let toolGroupIdx = 0;

  for (let i = 0; i < units.length; i++) {
    if (isToolGroup(units[i])) {
      if (toolGroupIdx < newWatermark) {
        truncateFlags[i] = true;
      }
      toolGroupIdx++;
    }
  }

  // Apply truncation
  const result = units.flatMap((unit, idx) => {
    if (!truncateFlags[idx]) return unit;
    return unit.map((msg) => {
      if (msg.role !== "tool") return msg;
      if (msg.content.length <= maxChars) return msg;
      const omitted = msg.content.length - head - tail;
      const truncated =
        msg.content.slice(0, head) +
        `\n\n[... ${omitted} chars omitted ...]\n\n` +
        msg.content.slice(-tail);
      return { ...msg, content: truncated };
    });
  });

  return { messages: result, watermark: newWatermark };
}
