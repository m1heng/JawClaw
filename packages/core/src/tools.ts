import type { ToolDefinition } from "./types.js";

// ── READ group (shared by Mouth and Hand) ──────────────────────────

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Supports optional line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" },
        offset: {
          type: "number",
          description: "Start reading from this line number (1-based). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read. Optional.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: {
          type: "string",
          description: "File or directory to search in. Defaults to current working directory.",
        },
        glob: {
          type: "string",
          description: 'Filter files by glob pattern, e.g. "*.ts"',
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns file paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Glob pattern, e.g. "src/**/*.ts", "*.json"',
        },
        path: {
          type: "string",
          description: "Directory to search in. Defaults to current working directory.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "memory_query",
    description:
      "Search shared memory files by keyword or regex. Memory is a semantic search interface (future VDB-backed), distinct from grep.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword or regex to search for in memory files",
        },
      },
      required: ["query"],
    },
  },
];

// ── DISPATCH group (Mouth only) ────────────────────────────────────

const DISPATCH_TOOLS: ToolDefinition[] = [
  {
    name: "dispatch_task",
    description:
      "Dispatch a task to a Hand Agent for execution. Use this for any task that requires writing files, running commands, or doing real work.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Clear description of what the Hand Agent should do",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List all active Hand Agent tasks with their status and progress.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "cancel_task",
    description:
      "Cancel a running Hand Agent task by its task ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to cancel",
        },
      },
      required: ["task_id"],
    },
  },
];

// ── WRITE group (Hand only) ────────────────────────────────────────

const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: "write_file",
    description: "Write content to a file. Creates the file and parent directories if they don't exist. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. The old_string must appear exactly once in the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        old_string: { type: "string", description: "The exact string to find and replace" },
        new_string: { type: "string", description: "The replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
];

// ── EXECUTE group (Hand only) ──────────────────────────────────────

const EXECUTE_TOOLS: ToolDefinition[] = [
  {
    name: "run_command",
    description:
      "Run a shell command and return stdout/stderr. Timeout defaults to 120 seconds.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        cwd: { type: "string", description: "Working directory. Optional." },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds. Default 120000 (2 min).",
        },
      },
      required: ["command"],
    },
  },
];

// ── EXTERNAL group (Hand only) ─────────────────────────────────────

const EXTERNAL_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the web and return results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "message",
    description:
      "Send a message to a chat through the IM channel. Use this to proactively notify the user or send to other chats.",
    parameters: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target chat ID" },
        text: { type: "string", description: "Message text to send" },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "cron",
    description:
      'Schedule a recurring or one-time delayed task. Use cron expression for recurring (e.g. "*/5 * * * *") or "once:<delayMs>" for one-time.',
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["schedule", "list", "delete"],
          description: "Action to perform",
        },
        description: {
          type: "string",
          description: "Task description (required for schedule)",
        },
        cron_expr: {
          type: "string",
          description: 'Cron expression or "once:<delayMs>" (required for schedule)',
        },
        id: {
          type: "string",
          description: "Cron entry ID (required for delete)",
        },
      },
      required: ["action"],
    },
  },
];

// ── Composed tool sets ─────────────────────────────────────────────

export const MOUTH_TOOLS: ToolDefinition[] = [
  ...READ_TOOLS,
  ...DISPATCH_TOOLS,
];

export const HAND_TOOLS: ToolDefinition[] = [
  ...READ_TOOLS,
  ...WRITE_TOOLS,
  ...EXECUTE_TOOLS,
  ...EXTERNAL_TOOLS,
];
