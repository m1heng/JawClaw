import type { ChatMessage } from "./types.js";
import { groupIntoUnits } from "./context.js";

export type MicrocompactOptions = {
  keepRecentGroups?: number; // default 3
  maxCharsPerResult?: number; // default 1500 - skip truncation if under this
  headChars?: number; // default 1000
  tailChars?: number; // default 500
};

/**
 * Truncate old tool results in-memory. Does NOT mutate input.
 * Keeps the most recent N tool-call groups intact.
 * Older tool-result messages get head+tail truncated.
 */
export function microcompactToolResults(
  messages: ChatMessage[],
  opts?: MicrocompactOptions,
): ChatMessage[] {
  const keepRecent = opts?.keepRecentGroups ?? 3;
  const maxChars = opts?.maxCharsPerResult ?? 1500;
  const head = opts?.headChars ?? 1000;
  const tail = opts?.tailChars ?? 500;

  const units = groupIntoUnits(messages);

  // Count tool-call groups from the end
  let toolGroupCount = 0;
  const isToolGroup = (unit: ChatMessage[]) =>
    unit.length > 1 && unit[0].role === "assistant" && unit[0].meta?.tool_calls;

  // Mark which groups to truncate
  const truncateFlags: boolean[] = new Array(units.length).fill(false);

  for (let i = units.length - 1; i >= 0; i--) {
    if (isToolGroup(units[i])) {
      toolGroupCount++;
      if (toolGroupCount > keepRecent) {
        truncateFlags[i] = true;
      }
    }
  }

  // Apply truncation
  return units.flatMap((unit, idx) => {
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
}
