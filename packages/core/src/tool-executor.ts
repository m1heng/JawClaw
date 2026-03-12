import type { ToolCall } from "./types.js";

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<string>;

export type ToolRegistry = Record<string, ToolHandler>;

export async function executeTool(
  call: ToolCall,
  registry: ToolRegistry,
): Promise<string> {
  const handler = registry[call.name];
  if (!handler) {
    return `Error: unknown tool "${call.name}"`;
  }
  try {
    return await handler(call.arguments);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error executing ${call.name}: ${message}`;
  }
}
