import { join } from "node:path";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { createReadTools } from "./read-tools.js";
import { createHandTools } from "./hand-tools.js";
import { runReactLoop } from "./react-loop.js";
import { buildSystemPrompt, handBootstrapFiles } from "./context.js";
import { HAND_TOOLS } from "./tools.js";
import type { AgentConfig, TaskDispatch, TaskResult, HandServices } from "./types.js";
import type { LLMClient } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import type { Shell } from "./providers/shell.js";

export type HandStatus = "running" | "completed" | "failed";

export class HandAgent {
  readonly id: string;
  readonly session: ChatSession;
  readonly queue: MessageQueue;
  readonly abortController = new AbortController();

  status: HandStatus = "running";
  currentTurn = 0;
  taskDescription: string;

  private task: TaskDispatch;
  private config: AgentConfig;
  private llm: LLMClient;
  private services: HandServices;
  private shell: Shell;

  constructor(params: {
    task: TaskDispatch;
    sessionsDir: string;
    config: AgentConfig;
    llm: LLMClient;
    services?: HandServices;
    shell: Shell;
  }) {
    this.id = generateId();
    this.task = params.task;
    this.taskDescription = params.task.description;
    this.config = { ...params.config, tools: HAND_TOOLS };
    this.llm = params.llm;
    this.services = params.services ?? {};
    this.shell = params.shell;
    this.session = new ChatSession(
      join(params.sessionsDir, `hand_${this.task.taskId}.jsonl`),
      params.shell,
    );
    this.queue = new MessageQueue();
  }

  async run(): Promise<TaskResult> {
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

    const basePrompt =
      this.config.systemPrompt +
      `\n\nMemory directory: ${memRoot}/` +
      `\nRead ${memRoot}/MEMORY.md for the memory index.`;
    const systemPrompt = await buildSystemPrompt(
      basePrompt,
      handBootstrapFiles(memRoot),
      this.shell,
    );
    const config = { ...this.config, systemPrompt };

    const fileMtimes = new Map<string, number>();
    const tools: ToolRegistry = {
      ...createReadTools(this.shell, memRoot, fileMtimes),
      ...createHandTools(this.shell, this.services, this.task.replyTo, fileMtimes),
    };

    try {
      const summary = await runReactLoop({
        session: this.session,
        queue: this.queue,
        config,
        llm: this.llm,
        tools,
        abortSignal: this.abortController.signal,
        onTurn: () => {
          this.currentTurn++;
        },
      });

      if (this.abortController.signal.aborted) {
        this.status = "failed";
        return {
          taskId: this.task.taskId,
          status: "failed",
          summary: "",
          error: "Task was cancelled.",
        };
      }

      this.status = "completed";
      return {
        taskId: this.task.taskId,
        status: "completed",
        summary,
      };
    } catch (err) {
      this.status = "failed";
      return {
        taskId: this.task.taskId,
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
