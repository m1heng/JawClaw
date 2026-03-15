import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { createReadTools } from "./read-tools.js";
import { runReactLoop } from "./react-loop.js";
import { buildSystemPrompt, handBootstrapFiles } from "./context.js";
import { HAND_TOOLS } from "./tools.js";
import type { AgentConfig, TaskDispatch, TaskResult, HandServices } from "./types.js";
import type { LLMClient } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import { join } from "node:path";

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
    // Include sourceChat path in the task message so Hand can read_file on it
    const taskMessage = [
      this.task.description,
      "",
      `Source chat session: ${this.task.sourceChat}`,
      "(Use read_file to review the original conversation for more context)",
    ].join("\n");

    await this.session.append({
      ts: new Date().toISOString(),
      role: "user",
      content: taskMessage,
    });

    const memRoot = this.services.memoryRoot ?? ".jawclaw/memory";

    // Inject identity files (SOUL.md, AGENTS.md, USER.md) + memory path hint
    const basePrompt =
      this.config.systemPrompt +
      `\n\nMemory directory: ${memRoot}/` +
      `\nRead ${memRoot}/MEMORY.md for the memory index.`;
    const systemPrompt = await buildSystemPrompt(
      basePrompt,
      handBootstrapFiles(memRoot),
    );
    const config = { ...this.config, systemPrompt };

    const tools: ToolRegistry = {
      // READ group (shared with Mouth via SSOT)
      ...createReadTools(memRoot),

      // WRITE group
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

      // EXECUTE group
      run_command: async (args) => {
        const command = args.command as string;
        const cwd = args.cwd as string | undefined;
        const timeout = (args.timeout as number) ?? 120_000;
        return runCommand(command, cwd, timeout);
      },

      // EXTERNAL group
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
          const sourceName = basename(this.task.sourceChat, ".jsonl");
          const chatId = sourceName.replace(/^mouth_/, "");
          const id = this.services.cronSchedule(description, cronExpr, chatId);
          return `Scheduled (${id}): "${description}" with expression "${cronExpr}".`;
        }
        return `Error: unknown cron action "${action}".`;
      },
    };

    try {
      const summary = await runReactLoop({
        session: this.session,
        queue: this.queue,
        config,
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
