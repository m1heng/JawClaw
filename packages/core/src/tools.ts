import type { ToolDefinition } from "./types.js";

export const MOUTH_TOOLS: ToolDefinition[] = [
  {
    name: "dispatch_task",
    description:
      "Dispatch a task to a Hand Agent for execution. Use this for any task that requires reading files, running commands, or doing real work.",
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
];

export const HAND_TOOLS: ToolDefinition[] = [
  // --- File Operations ---
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
  {
    name: "list_files",
    description:
      "List files matching a glob pattern. Returns file paths relative to the working directory.",
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

  // --- Command Execution ---
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

  // --- Context ---
  {
    name: "read_source_chat",
    description:
      "Read the Mouth Agent's chat session to get more context about the user's request.",
    parameters: {
      type: "object",
      properties: {},
    },
  },

  // --- Web ---
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

  // --- Messaging ---
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

  // --- Cron / Scheduling ---
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

  // --- Memory ---
  {
    name: "memory_query",
    description:
      "Search shared memory files by keyword. Returns matching content from memory files.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or regex to search for in memory files" },
      },
      required: ["query"],
    },
  },
];
