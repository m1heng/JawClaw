import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { createMemoryTools } from "./memory-tools.js";
import { runReactLoop } from "./react-loop.js";
import { HAND_TOOLS } from "./tools.js";
import type { AgentConfig, TaskDispatch, TaskResult, HandServices } from "./types.js";
import type { LLMClient } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";

function runCommand(
  command: string,
  cwd?: string,
  timeout = 120_000,
): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { timeout, maxBuffer: 10 * 1024 * 1024, cwd },
      (err, stdout, stderr) => {
        if (err) {
          resolve(
            `exit code ${err.code ?? 1}\nstdout: ${stdout}\nstderr: ${stderr}`,
          );
        } else {
          resolve(stdout + (stderr ? `\nstderr: ${stderr}` : ""));
        }
      },
    );
  });
}

export class HandAgent {
  readonly id: string;
  readonly session: ChatSession;
  readonly queue: MessageQueue;

  private task: TaskDispatch;
  private config: AgentConfig;
  private llm: LLMClient;
  private services: HandServices;

  constructor(params: {
    task: TaskDispatch;
    sessionsDir: string;
    config: AgentConfig;
    llm: LLMClient;
    services?: HandServices;
  }) {
    this.id = generateId();
    this.task = params.task;
    this.config = { ...params.config, tools: HAND_TOOLS };
    this.llm = params.llm;
    this.services = params.services ?? {};
    this.session = new ChatSession(
      join(params.sessionsDir, `hand_${this.task.taskId}.jsonl`),
    );
    this.queue = new MessageQueue();
  }

  async run(): Promise<TaskResult> {
    await this.session.append({
      ts: new Date().toISOString(),
      role: "user",
      content: this.task.description,
    });

    const memRoot = this.services.memoryRoot ?? ".jawclaw/memory";

    const tools: ToolRegistry = {
      // --- File Operations ---

      read_file: async (args) => {
        const path = args.path as string;
        const offset = args.offset as number | undefined;
        const limit = args.limit as number | undefined;
        try {
          const content = await readFile(path, "utf-8");
          if (offset !== undefined || limit !== undefined) {
            const lines = content.split("\n");
            const start = (offset ?? 1) - 1;
            const end = limit ? start + limit : lines.length;
            return lines
              .slice(start, end)
              .map((l, i) => `${start + i + 1}\t${l}`)
              .join("\n");
          }
          return content;
        } catch (err) {
          return errMsg("read_file", err);
        }
      },

      write_file: async (args) => {
        const path = args.path as string;
        const content = args.content as string;
        try {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, "utf-8");
          return `File written: ${path}`;
        } catch (err) {
          return errMsg("write_file", err);
        }
      },

      edit_file: async (args) => {
        const path = args.path as string;
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;
        try {
          const content = await readFile(path, "utf-8");
          const count = content.split(oldStr).length - 1;
          if (count === 0) return `Error: old_string not found in ${path}`;
          if (count > 1)
            return `Error: old_string appears ${count} times in ${path}. Must be unique.`;
          await writeFile(path, content.replace(oldStr, newStr), "utf-8");
          return `File edited: ${path}`;
        } catch (err) {
          return errMsg("edit_file", err);
        }
      },

      list_files: async (args) => {
        const pattern = args.pattern as string;
        const searchPath = (args.path as string) ?? ".";
        // Use find for simple patterns, glob-style via shell for ** patterns
        let cmd: string;
        if (pattern.includes("**") || pattern.includes("/")) {
          // Use shell globstar for path-based patterns
          cmd = `bash -O globstar -c 'ls -1 ${shellEscape(searchPath)}/${pattern} 2>/dev/null' | head -200`;
        } else {
          cmd = `find ${shellEscape(searchPath)} -type f -name ${shellEscape(pattern)} 2>/dev/null | head -200`;
        }
        const result = await runCommand(cmd);
        return result || "(no files found)";
      },

      grep: async (args) => {
        const pattern = args.pattern as string;
        const searchPath = (args.path as string) ?? ".";
        const glob = args.glob as string | undefined;
        const includeFlag = glob ? `--include='${glob}'` : "";
        const result = await runCommand(
          `grep -rn ${includeFlag} -E ${shellEscape(pattern)} ${shellEscape(searchPath)} 2>/dev/null | head -100`,
        );
        return result || "(no matches)";
      },

      // --- Command Execution ---

      run_command: async (args) => {
        const command = args.command as string;
        const cwd = args.cwd as string | undefined;
        const timeout = (args.timeout as number) ?? 120_000;
        return runCommand(command, cwd, timeout);
      },

      // --- Context ---

      read_source_chat: async () => {
        try {
          return await readFile(this.task.sourceChat, "utf-8");
        } catch (err) {
          return errMsg("read_source_chat", err);
        }
      },

      // --- Web Search ---

      web_search: async (args) => {
        const query = args.query as string;
        if (!this.services.webSearch) {
          return "Error: web_search is not configured. Set WEB_SEARCH_PROVIDER.";
        }
        try {
          return await this.services.webSearch(query);
        } catch (err) {
          return errMsg("web_search", err);
        }
      },

      // --- Messaging ---

      message: async (args) => {
        const chatId = args.chat_id as string;
        const text = args.text as string;
        if (!this.services.sendMessage) {
          return "Error: message sending is not available.";
        }
        try {
          await this.services.sendMessage(chatId, text);
          return `Message sent to ${chatId}.`;
        } catch (err) {
          return errMsg("message", err);
        }
      },

      // --- Cron ---

      cron: async (args) => {
        const action = args.action as string;
        if (action === "list") {
          if (!this.services.cronList) return "Error: cron not configured.";
          const entries = this.services.cronList();
          if (entries.length === 0) return "(no scheduled tasks)";
          return entries
            .map((e) => `${e.id}  ${e.cronExpr}  ${e.description}  next: ${e.nextRun}`)
            .join("\n");
        }
        if (action === "delete") {
          const id = args.id as string;
          if (!this.services.cronDelete) return "Error: cron not configured.";
          return this.services.cronDelete(id)
            ? `Deleted cron ${id}.`
            : `Cron ${id} not found.`;
        }
        if (action === "schedule") {
          const description = args.description as string;
          const cronExpr = args.cron_expr as string;
          if (!description || !cronExpr)
            return "Error: description and cron_expr required for schedule.";
          if (!this.services.cronSchedule) return "Error: cron not configured.";
          // Extract chatId from source chat path: mouth_{chatId}.jsonl
          const sourceName = basename(this.task.sourceChat, ".jsonl");
          const chatId = sourceName.replace(/^mouth_/, "");
          const id = this.services.cronSchedule(description, cronExpr, chatId);
          return `Scheduled (${id}): "${description}" with expression "${cronExpr}".`;
        }
        return `Error: unknown cron action "${action}".`;
      },

      // --- Memory (shared implementation) ---
      ...createMemoryTools(memRoot),
    };

    try {
      const summary = await runReactLoop({
        session: this.session,
        queue: this.queue,
        config: this.config,
        llm: this.llm,
        tools,
      });

      return {
        taskId: this.task.taskId,
        status: "completed",
        summary,
      };
    } catch (err) {
      return {
        taskId: this.task.taskId,
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function errMsg(tool: string, err: unknown): string {
  return `Error in ${tool}: ${err instanceof Error ? err.message : String(err)}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
