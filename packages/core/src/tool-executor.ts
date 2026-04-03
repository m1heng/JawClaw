import type { ToolCall } from "./types.js";
import { READ_TOOLS } from "./tools.js";

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<string>;

export type ToolRegistry = Record<string, ToolHandler>;

// ── Tool Result Budget ──────────────────────────────────────────

export const DEFAULT_RESULT_BUDGET = 30_000;

/** Truncate a tool result that exceeds the budget (70% head + 20% tail). */
export function applyResultBudget(
  result: string,
  maxChars: number = DEFAULT_RESULT_BUDGET,
): string {
  if (result.length <= maxChars) return result;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  const omitted = result.length - headChars - tailChars;
  return (
    result.slice(0, headChars) +
    `\n\n[... ${omitted} chars omitted (result budget) ...]\n\n` +
    result.slice(-tailChars)
  );
}

// ── Tool Execution ──────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  registry: ToolRegistry,
  maxResultChars?: number,
): Promise<string> {
  const handler = registry[call.name];
  if (!handler) {
    return `Error: unknown tool "${call.name}"`;
  }
  try {
    const raw = await handler(call.arguments);
    return applyResultBudget(raw, maxResultChars);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error executing ${call.name}: ${message}`;
  }
}

// ── Concurrent Tool Execution ───────────────────────────────────

/** Tools that are safe to execute in parallel (read-only, no side effects). */
export const CONCURRENT_SAFE_TOOLS = new Set(
  READ_TOOLS.map((t) => t.name),
);

/**
 * Execute tool calls with concurrency when safe.
 * All-read batches run in parallel; any exclusive tool triggers serial execution.
 * Returns results in the same order as input calls.
 */
export async function executeToolsConcurrently(
  calls: ToolCall[],
  registry: ToolRegistry,
  maxResultChars?: number,
): Promise<string[]> {
  if (calls.length === 0) return [];

  const allSafe = calls.every((c) => CONCURRENT_SAFE_TOOLS.has(c.name));

  if (allSafe && calls.length > 1) {
    return Promise.all(
      calls.map((call) => executeTool(call, registry, maxResultChars)),
    );
  }

  const results: string[] = [];
  for (const call of calls) {
    results.push(await executeTool(call, registry, maxResultChars));
  }
  return results;
}
