import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { HandAgent } from "./hand-agent.js";
import { createReadTools } from "./read-tools.js";
import { runReactLoop } from "./react-loop.js";
import { buildSystemPrompt, mouthBootstrapFiles } from "./context.js";
import { MOUTH_TOOLS } from "./tools.js";
import type { AgentConfig, TaskDispatch, TaskResult, HandServices } from "./types.js";
import type { LLMClient } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";

const MOUTH_SYSTEM_PROMPT = `You are the Mouth Agent (Jaw) of JawClaw. You are the conversational interface to the user.

Your job:
- Understand user requests
- Acknowledge quickly with brief, friendly messages
- Dispatch tasks to Hand Agents using the dispatch_task tool
- Relay results when tasks complete
- Use read_file, grep, glob to gather context before dispatching
- Use memory_query to search shared memory for relevant context

Rules:
- NEVER try to execute coding tasks yourself — always dispatch to Hand Agents
- You can READ files and search, but NEVER write files or run commands
- Be concise and friendly
- For simple greetings or questions about yourself, respond directly without dispatching
- You may receive multiple user messages at once — read them all before responding`;

const HAND_SYSTEM_PROMPT = `You are a Hand Agent (Claw) of JawClaw. You execute coding tasks.

Your job:
- Execute the task described in your initial message
- Use tools to read files, run commands, write/edit files, search, and gather information
- The source chat session path is included in your task — use read_file on it for more context
- Provide a clear, concise summary when done

Tools available:
- Read: read_file, grep, glob
- Write: write_file, edit_file
- Execute: run_command
- External: web_search, message (send to IM channels), cron (schedule/list/delete tasks)
- Memory: memory_query (search shared memory), write_file to .jawclaw/memory/ for persistence

Rules:
- Stay focused on your assigned task
- Be thorough but efficient
- Your final message will be shown directly to the user, so make it clear and useful`;

/** Max messages to batch-drain per react loop cycle. */
const MAX_BATCH = 5;

/** Messages since last summary before auto-summary triggers. */
const SUMMARY_THRESHOLD = 20;


export class MouthAgent {
  readonly id: string;
  readonly session: ChatSession;
  readonly queue: MessageQueue;
  private activeHands: Map<string, HandAgent> = new Map();
  private loopRunning = false;
  private sendReply: ((text: string) => Promise<void>) | null = null;
  private sessionsDir: string;
  private config: AgentConfig;
  private llm: LLMClient;
  private handConfig: AgentConfig;
  private handLlm: LLMClient;
  private handServices: HandServices;
  private lastSummaryMessageCount = 0;

  constructor(params: {
    chatId: string;
    sessionsDir: string;
    config: Omit<AgentConfig, "systemPrompt" | "tools">;
    llm: LLMClient;
    handConfig: Omit<AgentConfig, "systemPrompt" | "tools">;
    handLlm: LLMClient;
    handServices?: HandServices;
  }) {
    this.id = params.chatId;
    this.sessionsDir = params.sessionsDir;
    this.session = new ChatSession(
      join(params.sessionsDir, `mouth_${params.chatId}.jsonl`),
    );
    this.queue = new MessageQueue();
    this.config = {
      ...params.config,
      systemPrompt: MOUTH_SYSTEM_PROMPT,
      tools: MOUTH_TOOLS,
    };
    this.llm = params.llm;

    this.handConfig = {
      ...params.handConfig,
      systemPrompt: HAND_SYSTEM_PROMPT,
      tools: [],
    };
    this.handLlm = params.handLlm;
    this.handServices = params.handServices ?? {};
  }

  /**
   * Enqueue a user message. If the drain loop isn't running, start it.
   */
  async handleMessage(
    text: string,
    sendReply: (text: string) => Promise<void>,
  ): Promise<void> {
    this.sendReply = sendReply;
    this.queue.enqueue({
      content: text,
      from: "user",
      ts: new Date().toISOString(),
    });

    if (!this.loopRunning) {
      this.loopRunning = true;
      // Don't await — let it run independently
      this.drainLoop().finally(() => {
        this.loopRunning = false;
      });
    }
  }

  /**
   * Drain loop: while there are messages in the queue, batch-process them.
   * Natural batching: messages that arrive during LLM processing
   * accumulate in the queue and get drained in the next iteration.
   */
  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.drain(MAX_BATCH);

      for (const msg of batch) {
        await this.session.append({
          ts: msg.ts,
          role: "user",
          content: msg.content,
        });
      }

      // One react loop for the batch.
      // While this runs, new messages accumulate in the queue.
      await this.runOnce();
    }

    // Queue empty — check if we should auto-summarize
    this.maybeSummarize();
  }

  private async runOnce(): Promise<void> {
    const sendReply = this.sendReply!;
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";

    // Inject bootstrap files (SOUL.md, AGENTS.md, USER.md, MEMORY.md)
    const systemPrompt = await buildSystemPrompt(
      MOUTH_SYSTEM_PROMPT,
      mouthBootstrapFiles(memRoot),
    );
    const configWithMemory = { ...this.config, systemPrompt };

    const tools: ToolRegistry = {
      // READ group (shared with Hand via SSOT)
      ...createReadTools(memRoot),

      // DISPATCH group
      dispatch_task: async (args) => {
        const description = args.description as string;
        const taskId = generateId();

        const task: TaskDispatch = {
          taskId,
          description,
          sourceChat: this.session.filePath,
        };

        const hand = new HandAgent({
          task,
          sessionsDir: this.sessionsDir,
          config: this.handConfig,
          llm: this.handLlm,
          services: this.handServices,
        });

        this.activeHands.set(taskId, hand);

        hand.run().then(
          (result) => {
            this.activeHands.delete(taskId);
            this.onHandComplete(result, sendReply);
          },
          (err) => {
            this.activeHands.delete(taskId);
            const result: TaskResult = {
              taskId,
              status: "failed",
              summary: "",
              error: err instanceof Error ? err.message : String(err),
            };
            this.onHandComplete(result, sendReply);
          },
        );

        return `Task dispatched (${taskId}). You will be notified when it completes.`;
      },
    };

    await runReactLoop({
      session: this.session,
      queue: this.queue,
      config: configWithMemory,
      llm: this.llm,
      tools,
      onAssistantMessage: async (content) => {
        if (content) await sendReply(content);
      },
    });
  }

  private async onHandComplete(
    result: TaskResult,
    sendReply: (text: string) => Promise<void>,
  ): Promise<void> {
    const message =
      result.status === "completed"
        ? result.summary
        : `Task failed: ${result.error ?? "unknown error"}`;

    await this.session.append({
      ts: new Date().toISOString(),
      role: "system",
      content: `[Hand Agent completed task ${result.taskId}]\n${message}`,
    });

    await sendReply(message);
  }

  /**
   * Auto-summarize: if enough new messages since last summary,
   * dispatch a background Hand to generate a session summary.
   * Checkpoint is persisted to disk so restarts don't re-summarize.
   */
  private maybeSummarize(): void {
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    const checkpointPath = join(memRoot, ".summary-checkpoint-" + this.id);

    // Fire-and-forget: read checkpoint + session, decide, dispatch
    (async () => {
      // Load persisted checkpoint (survives restarts)
      let checkpoint = this.lastSummaryMessageCount;
      try {
        const stored = await readFile(checkpointPath, "utf-8");
        const parsed = parseInt(stored.trim(), 10);
        if (parsed > checkpoint) checkpoint = parsed;
      } catch {
        // No checkpoint file yet
      }

      const allMessages = await this.session.readAll();
      const newCount = allMessages.length - checkpoint;
      if (newCount < SUMMARY_THRESHOLD) return;

      // Update counter + persist before dispatch to prevent re-triggering
      this.lastSummaryMessageCount = allMessages.length;
      await mkdir(memRoot, { recursive: true });
      await writeFile(checkpointPath, String(allMessages.length), "utf-8");

      const today = new Date().toISOString().slice(0, 10);
      const ts = Date.now();
      const summaryPath = join(memRoot, "sessions", `${today}-chat-${this.id}-${ts}.md`);
      const memoryMdPath = join(memRoot, "MEMORY.md");

      const description = [
        "Generate a concise summary of the recent conversation and persist it to memory.",
        "",
        "Instructions:",
        "1. Read the source chat session to understand what was discussed",
        `2. Write a summary to: ${summaryPath}`,
        "   - Use YAML frontmatter: type: session-summary, date: " + today,
        "   - Include key decisions, action items, facts learned, user preferences",
        `3. Update ${memoryMdPath} to include a reference to the new summary file`,
        "   - If MEMORY.md doesn't exist, create it with a header and the first entry",
        "   - If it exists, use edit_file to append the new entry (don't overwrite)",
      ].join("\n");

      const taskId = generateId();
      const task: TaskDispatch = {
        taskId,
        description,
        sourceChat: this.session.filePath,
      };

      const hand = new HandAgent({
        task,
        sessionsDir: this.sessionsDir,
        config: this.handConfig,
        llm: this.handLlm,
        services: this.handServices,
      });

      this.activeHands.set(taskId, hand);

      // Fire and forget — don't notify user about housekeeping
      hand.run().then(
        (result) => {
          this.activeHands.delete(taskId);
          if (result.status === "failed") {
            console.error(`[auto-summary] Task ${taskId} failed: ${result.error}`);
          }
        },
        (err) => {
          this.activeHands.delete(taskId);
          console.error(`[auto-summary] Task ${taskId} error:`, err);
        },
      );
    })().catch(() => {
      // Session/checkpoint read failed — skip this cycle
    });
  }
}
