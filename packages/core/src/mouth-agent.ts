import { join } from "node:path";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { HandAgent } from "./hand-agent.js";
import { createReadTools } from "./read-tools.js";
import { runReactLoop } from "./react-loop.js";
import { buildSystemPrompt, mouthBootstrapFiles } from "./context.js";
import { MOUTH_TOOLS } from "./tools.js";
import type {
  AgentConfig,
  TaskDispatch,
  TaskResult,
  HandServices,
  SendMessageFn,
} from "./types.js";
import type { LLMClient } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import type { Shell } from "./providers/shell.js";

const MOUTH_SYSTEM_PROMPT = `You are the Mouth Agent (Jaw) of JawClaw — the conversational interface.

You have ONE unified session that receives messages from ALL connected channels.
Each user message includes metadata: chat_id, sender_id, sender_name, channel.

Your job:
- Understand user requests from any channel
- Reply using the \`message\` tool with the correct chat_id
- Dispatch tasks to Hand Agents using dispatch_task
- Use read_file, grep, glob, memory_query to gather context before dispatching

IMPORTANT:
- Your text output is internal reasoning — it is NOT delivered to any channel.
- You MUST use the \`message\` tool every time you want a user to see something.
- NEVER try to execute coding tasks yourself — always dispatch to Hand Agents.
- You can READ files and search, but NEVER write files or run commands.
- For simple greetings or questions, reply directly via \`message\` without dispatching.
- You may receive messages from multiple channels at once — read the metadata to know who sent what.`;

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

export type MessageMeta = {
  chatId: string;
  senderId: string;
  senderName?: string;
  channel?: string;
};

export class MouthAgent {
  readonly id = "mouth";
  readonly session: ChatSession;
  readonly queue: MessageQueue;
  private activeHands: Map<string, HandAgent> = new Map();
  private loopRunning = false;
  private sessionsDir: string;
  private config: AgentConfig;
  private llm: LLMClient;
  private handConfig: AgentConfig;
  private handLlm: LLMClient;
  private handServices: HandServices;
  private sendMessage: SendMessageFn;
  private shell: Shell;
  private lastSummaryMessageCount = 0;

  constructor(params: {
    sessionsDir: string;
    config: Omit<AgentConfig, "systemPrompt" | "tools">;
    llm: LLMClient;
    handConfig: Omit<AgentConfig, "systemPrompt" | "tools">;
    handLlm: LLMClient;
    handServices?: HandServices;
    sendMessage: SendMessageFn;
    shell: Shell;
  }) {
    this.sessionsDir = params.sessionsDir;
    this.session = new ChatSession(
      join(params.sessionsDir, "mouth.jsonl"),
      params.shell,
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
    this.sendMessage = params.sendMessage;
    this.shell = params.shell;
  }

  /**
   * Enqueue a user message with channel provenance.
   * If the drain loop isn't running, start it.
   */
  async handleMessage(text: string, meta: MessageMeta): Promise<void> {
    this.queue.enqueue({
      content: text,
      from: meta.senderId,
      ts: new Date().toISOString(),
      meta: {
        chat_id: meta.chatId,
        sender_id: meta.senderId,
        sender_name: meta.senderName,
        channel: meta.channel,
      },
    });

    if (!this.loopRunning) {
      this.loopRunning = true;
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
          meta: msg.meta,
        });
      }

      await this.runOnce();
    }

    // Queue empty — check if we should auto-summarize
    this.maybeSummarize();
  }

  private async runOnce(): Promise<void> {
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";

    // Inject bootstrap files (SOUL.md, INSTRUCTIONS.md, MEMORY.md)
    const systemPrompt = await buildSystemPrompt(
      MOUTH_SYSTEM_PROMPT,
      mouthBootstrapFiles(memRoot),
      this.shell,
    );
    const configWithMemory = { ...this.config, systemPrompt };

    const tools: ToolRegistry = {
      // READ group (shared with Hand via SSOT)
      ...createReadTools(this.shell, memRoot),

      // MESSAGE tool — explicit channel delivery
      message: async (args) => {
        const chatId = args.chat_id as string;
        const text = args.text as string;
        try {
          await this.sendMessage(chatId, text);
          return `Message sent to ${chatId}.`;
        } catch (err) {
          return `Error sending message: ${err instanceof Error ? err.message : String(err)}`;
        }
      },

      // DISPATCH group
      dispatch_task: async (args) => {
        const description = args.description as string;
        const replyTo = args.reply_to as string | undefined;
        const taskId = generateId();

        const task: TaskDispatch = {
          taskId,
          description,
          sourceChat: this.session.filePath,
          replyTo,
        };

        const hand = new HandAgent({
          task,
          sessionsDir: this.sessionsDir,
          config: this.handConfig,
          llm: this.handLlm,
          services: this.handServices,
          shell: this.shell,
        });

        this.activeHands.set(taskId, hand);

        hand.run().then(
          (result) => {
            this.activeHands.delete(taskId);
            this.onHandComplete({ ...result, replyTo: task.replyTo });
          },
          (err) => {
            this.activeHands.delete(taskId);
            this.onHandComplete({
              taskId,
              status: "failed",
              summary: "",
              error: err instanceof Error ? err.message : String(err),
              replyTo: task.replyTo,
            });
          },
        );

        return `Task dispatched (${taskId}). You will be notified when it completes.`;
      },

      list_tasks: async () => {
        if (this.activeHands.size === 0) return "(no active tasks)";
        const lines: string[] = [];
        for (const [id, hand] of this.activeHands) {
          lines.push(
            `${id}  ${hand.status}  turn ${hand.currentTurn}  ${hand.taskDescription.slice(0, 80)}`,
          );
        }
        return lines.join("\n");
      },

      cancel_task: async (args) => {
        const taskId = args.task_id as string;
        const hand = this.activeHands.get(taskId);
        if (!hand) return `Error: task ${taskId} not found.`;
        hand.abortController.abort();
        return `Task ${taskId} cancellation requested.`;
      },
    };

    await runReactLoop({
      session: this.session,
      queue: this.queue,
      config: configWithMemory,
      llm: this.llm,
      tools,
      // Assistant text is internal reasoning — not sent to any channel
    });
  }

  private async onHandComplete(
    result: TaskResult & { replyTo?: string },
  ): Promise<void> {
    // Cancelled tasks: record in session but don't notify user
    if (result.error === "Task was cancelled.") {
      await this.session.append({
        ts: new Date().toISOString(),
        role: "system",
        content: `[Hand Agent task ${result.taskId} was cancelled]`,
      });
      return;
    }

    const message =
      result.status === "completed"
        ? result.summary
        : `Task failed: ${result.error ?? "unknown error"}`;

    await this.session.append({
      ts: new Date().toISOString(),
      role: "system",
      content: `[Hand Agent completed task ${result.taskId}]\n${message}`,
    });

    if (result.replyTo) {
      try {
        await this.sendMessage(result.replyTo, message);
      } catch (err) {
        console.error(
          `[mouth] Failed to send Hand result to ${result.replyTo}:`,
          err,
        );
      }
    }
  }

  /**
   * Auto-summarize: if enough new messages since last summary,
   * dispatch a background Hand to generate a session summary.
   * Checkpoint is persisted to disk so restarts don't re-summarize.
   */
  private maybeSummarize(): void {
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    const checkpointPath = join(memRoot, ".summary-checkpoint");

    // Fire-and-forget: read checkpoint + session, decide, dispatch
    (async () => {
      // Load persisted checkpoint (survives restarts)
      let checkpoint = this.lastSummaryMessageCount;
      try {
        const stored = await this.shell.readFile(checkpointPath);
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
      await this.shell.mkdir(memRoot);
      await this.shell.writeFile(checkpointPath, String(allMessages.length));

      const today = new Date().toISOString().slice(0, 10);
      const ts = Date.now();
      const summaryPath = join(
        memRoot,
        "summaries",
        `${today}-${ts}.md`,
      );
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
        shell: this.shell,
      });

      this.activeHands.set(taskId, hand);

      // Fire and forget — don't notify user about housekeeping
      hand.run().then(
        (result) => {
          this.activeHands.delete(taskId);
          if (result.status === "failed") {
            console.error(
              `[auto-summary] Task ${taskId} failed: ${result.error}`,
            );
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
