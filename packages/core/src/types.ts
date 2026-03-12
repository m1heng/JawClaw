export type ChatMessage = {
  ts: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  meta?: {
    tool_call_id?: string;
    tool_name?: string;
    tool_args?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type TaskDispatch = {
  taskId: string;
  description: string;
  sourceChat: string; // file path to Mouth's .jsonl
};

export type TaskResult = {
  taskId: string;
  status: "completed" | "failed";
  summary: string;
  error?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AgentConfig = {
  model: string;
  baseUrl?: string;
  apiKey: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns?: number;
};

// --- Service interfaces for pluggable capabilities ---

export type SendMessageFn = (
  chatId: string,
  text: string,
) => Promise<void>;

export type WebSearchFn = (
  query: string,
) => Promise<string>;

export type CronEntry = {
  id: string;
  description: string;
  cronExpr: string; // cron expression or "once:<delayMs>"
  nextRun: string;
};

export type CronScheduleFn = (
  description: string,
  cronExpr: string,
  chatId: string,
) => string;

export type HandServices = {
  sendMessage?: SendMessageFn;
  webSearch?: WebSearchFn;
  cronSchedule?: CronScheduleFn;
  cronList?: () => CronEntry[];
  cronDelete?: (id: string) => boolean;
  memoryRoot?: string;
};
