import { join } from "node:path";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { HandAgent } from "./hand-agent.js";
import { createReadTools } from "./read-tools.js";
import { runReactLoop } from "./react-loop.js";
import { buildSystemPrompt, mouthStableBootstrapFiles, mouthDynamicBootstrapFiles } from "./context.js";
import { MOUTH_TOOLS } from "./tools.js";
import { extractSessionMemory } from "./session-memory.js";
import { recallMemories } from "./memory-recall.js";
import type {
  AgentConfig,
  CompressionState,
  TaskDispatch,
  TaskResult,
  HandServices,
  SendMessageFn,
} from "./types.js";
import type { LLMClient, LLMUsage } from "./llm.js";
import type { ToolRegistry } from "./tool-executor.js";
import type { Shell } from "./providers/shell.js";

const MOUTH_SYSTEM_PROMPT = `You are the Mouth Agent (Jaw) of JawClaw — the conversational interface.

You have ONE unified session that receives messages from ALL connected channels.
Each user message includes metadata: chat_id, sender_id, sender_name, channel.

Your job:
- Understand user requests from any channel
- Reply FAST using the \`message\` tool with the correct chat_id
- Dispatch tasks to Hand Agents using dispatch_task for any non-trivial work

DISPATCH RULE — this is critical:
- If a request needs MORE THAN ONE round of tool calls (reading, searching, etc.), dispatch it to a Hand Agent IMMEDIATELY.
- Do NOT chain multiple read_file / grep / glob calls yourself. That is the Hand Agent's job.
- You may do ONE quick lookup (a single glob or read_file) to understand what the user is asking about, but no more.
- Your priority is SPEED. Acknowledge the user fast ("on it", "looking into it"), dispatch, move on.
- Examples of what to dispatch: "look at the code", "review X", "explain the architecture", "find the bug", "analyze Y"
- Examples of what to handle directly: "hello", "what can you do", "what's your name", a quick factual question from memory

HAND AGENT RESULTS:
- When a Hand Agent completes, its result appears as a message from sender "Hand Agent" (channel=internal).
- The message metadata contains the chat_id of the user who requested the task.
- You MUST process the result and send a response to the user using the \`message\` tool with that chat_id.
- Summarize or reformat as appropriate for the conversation context. Do not just echo the raw result.
- If the task failed, let the user know clearly and suggest next steps.

IMPORTANT:
- Your text output is internal reasoning — it is NOT delivered to any channel.
- You MUST use the \`message\` tool every time you want a user to see something.
- NEVER try to execute coding tasks yourself — always dispatch to Hand Agents.
- You can READ files and search, but NEVER write files or run commands.
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
- External: web_search, message (send urgent updates to IM channels), cron (schedule/list/delete tasks)
- Memory: memory_query (search shared memory), write_file to .jawclaw/memory/ for persistence

Rules:
- Stay focused on your assigned task
- Be thorough but efficient
- Your text output is a work report for the Mouth Agent, not shown directly to the user. Be factual and structured.
- Use the \`message\` tool only for urgent progress updates (e.g., "this will take a while"). Your final result goes through Mouth automatically.`;

/** Max messages to batch-drain per react loop cycle. */
const MAX_BATCH = 5;

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
  private pendingHandResults = false;
  private sessionsDir: string;
  private config: AgentConfig;
  private llm: LLMClient;
  private handConfig: AgentConfig;
  private handLlm: LLMClient;
  private handServices: HandServices;
  private sendMessage: SendMessageFn;
  private shell: Shell;
  private lastSessionMemoryCheckpoint = 0;
  private extractingMemory = false;
  private consolidating = false;
  private lastConsolidationTs = 0;
  private compressionState: CompressionState = { microcompactWatermark: 0 };

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
    // Commands: handle locally without going through LLM
    const cmd = this.matchCommand(text.trim());
    if (cmd) {
      const result = await cmd();
      try { await this.sendMessage(meta.chatId, result); } catch { /* send failure */ }
      return;
    }

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
   * Match a /command and return its handler, or null.
   * Note: commands are currently available to all channels (single-owner design).
   * Multi-tenant deployments should add auth before exposing commands.
   */
  private matchCommand(text: string): (() => Promise<string>) | null {
    if (!text.startsWith("/")) return null;
    const [cmd] = text.split(/\s+/, 1);
    switch (cmd) {
      case "/status":
        return () => this.cmdStatus();
      case "/clear":
        return () => this.cmdClear();
      default:
        return null;
    }
  }

  private async cmdStatus(): Promise<string> {
    const messages = await this.session.readAll();
    const hands = this.activeHands.size;
    const lines = [
      `Session: ${messages.length} messages`,
      `Active tasks: ${hands}`,
    ];
    if (hands > 0) {
      for (const [id, hand] of this.activeHands) {
        lines.push(`  ${id} [${hand.status}] turn ${hand.currentTurn} — ${hand.taskDescription.slice(0, 60)}`);
      }
    }
    return lines.join("\n");
  }

  private async cmdClear(): Promise<string> {
    // Refuse if Hand agents are still running
    if (this.activeHands.size > 0) {
      return `Cannot clear: ${this.activeHands.size} task(s) still running. Cancel them first.`;
    }
    // Refuse if the Mouth loop is still processing
    if (this.loopRunning) {
      return `Cannot clear: Mouth is still processing. Try again shortly.`;
    }
    // Archive current session file, start fresh
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(this.sessionsDir, `mouth_${ts}.jsonl`);
    try {
      const content = await this.shell.readFile(this.session.filePath);
      await this.shell.writeFile(archivePath, content);
    } catch { /* no existing session to archive */ }
    await this.shell.writeFile(this.session.filePath, "");
    // Reset all checkpoints, session memory, and compression state
    this.lastSessionMemoryCheckpoint = 0;
    this.compressionState = { microcompactWatermark: 0 };
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    await this.shell.writeFile(join(memRoot, ".session-memory-checkpoint"), "0").catch(() => {});
    await this.shell.writeFile(join(memRoot, "session-memory.md"), "").catch(() => {});
    return `Session cleared. Previous session archived to ${archivePath}`;
  }

  /**
   * Drain loop: while there are messages in the queue, batch-process them.
   * Natural batching: messages that arrive during LLM processing
   * accumulate in the queue and get drained in the next iteration.
   */
  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0 || this.pendingHandResults) {
      this.pendingHandResults = false;
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

    // Queue empty — background housekeeping
    this.maybeExtractSessionMemory();
    this.maybeConsolidateMemory();
  }

  private async runOnce(): Promise<void> {
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    const sessionMemoryPath = join(memRoot, "session-memory.md");

    // Recall relevant memories via LLM
    const recentMessages = await this.session.readTail(10);
    const recalled = await recallMemories({
      shell: this.shell,
      memoryRoot: memRoot,
      recentMessages,
      llm: this.llm,
      model: this.config.model,
    });

    // Build stable system prompt (SOUL.md, INSTRUCTIONS.md — rarely changes, cacheable)
    const stablePrompt = await buildSystemPrompt(
      MOUTH_SYSTEM_PROMPT,
      mouthStableBootstrapFiles(memRoot),
      this.shell,
    );

    // Build dynamic system prompt (MEMORY.md, session-memory.md + recalled memories)
    const dynamicParts: string[] = [];
    const dynamicBootstrap = await buildSystemPrompt(
      "",
      mouthDynamicBootstrapFiles(memRoot),
      this.shell,
    );
    if (dynamicBootstrap.trim()) dynamicParts.push(dynamicBootstrap);
    if (recalled) dynamicParts.push(recalled);
    const dynamicPrompt = dynamicParts.join("\n\n") || undefined;

    const configWithMemory = {
      ...this.config,
      systemPrompt: stablePrompt,
      dynamicSystemPrompt: dynamicPrompt,
    };

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
          onUsage: (usage) => this.logUsage(usage, "hand"),
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
      sessionMemoryPath,
      shell: this.shell,
      onUsage: (usage) => this.logUsage(usage, "mouth"),
      compressionState: this.compressionState,
      // Assistant text is internal reasoning — not sent to any channel
    });
  }

  private async onHandComplete(
    result: TaskResult & { replyTo?: string },
  ): Promise<void> {
    // Cancelled tasks: record in session but don't trigger Mouth processing
    if (result.error === "Task was cancelled.") {
      await this.session.append({
        ts: new Date().toISOString(),
        role: "user",
        content: `[Hand Agent task ${result.taskId} was cancelled]`,
        meta: { chat_id: result.replyTo ?? "", sender_id: "hand", sender_name: "Hand Agent", channel: "internal" },
      });
      return;
    }

    const summary =
      result.status === "completed"
        ? result.summary
        : `Task failed: ${result.error ?? "unknown error"}`;

    // Append directly to session (not queue — avoids react-loop drain race).
    // Uses role "user" so all LLM providers see it (Anthropic/Gemini drop mid-session system messages).
    await this.session.append({
      ts: new Date().toISOString(),
      role: "user",
      content: `[Hand Agent completed task ${result.taskId}]\n${summary}`,
      meta: { chat_id: result.replyTo ?? "", sender_id: "hand", sender_name: "Hand Agent", channel: "internal" },
    });

    // Trigger Mouth to process the result
    this.pendingHandResults = true;
    if (!this.loopRunning) {
      this.loopRunning = true;
      this.drainLoop().finally(() => {
        this.loopRunning = false;
      });
    }
  }

  /**
   * Extract structured session memory via LLM when enough new messages
   * have accumulated. Replaces the old Hand-based auto-summary.
   * Checkpoint is persisted to disk so restarts don't re-extract.
   */
  private maybeExtractSessionMemory(): void {
    // Guard: skip if an extraction is already in flight
    if (this.extractingMemory) return;

    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    const checkpointPath = join(memRoot, ".session-memory-checkpoint");

    this.extractingMemory = true;

    // Fire-and-forget
    (async () => {
      // Load persisted checkpoint
      let checkpoint = this.lastSessionMemoryCheckpoint;
      try {
        const stored = await this.shell.readFile(checkpointPath);
        const parsed = parseInt(stored.trim(), 10);
        if (parsed > checkpoint) checkpoint = parsed;
      } catch {
        // No checkpoint yet
      }

      const result = await extractSessionMemory({
        session: this.session,
        llm: this.llm, // Use Mouth's LLM (fast model)
        model: this.config.model,
        shell: this.shell,
        memoryRoot: memRoot,
        lastCheckpoint: checkpoint,
      });

      if (result) {
        this.lastSessionMemoryCheckpoint = result.newCheckpoint;
      }
    })()
      .catch(() => {
        // Extraction failed — skip this cycle
      })
      .finally(() => {
        this.extractingMemory = false;
      });
  }

  /** Append LLM usage to .jawclaw/usage.jsonl (fire-and-forget). */
  private logUsage(usage: LLMUsage, agent: "mouth" | "hand"): void {
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    const usagePath = join(memRoot, "..", "usage.jsonl");
    const model = agent === "mouth" ? this.config.model : this.handConfig.model;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      agent,
      model,
      ...usage,
    });
    this.shell.appendFile(usagePath, entry + "\n").catch(() => {});
  }

  /**
   * Dispatch a consolidation Hand Agent when idle and gates pass:
   * - No active Hand agents
   * - Not already consolidating
   * - ≥24h since last consolidation
   * - ≥50 new session messages since last consolidation
   */
  private maybeConsolidateMemory(): void {
    if (this.consolidating) return;
    if (this.activeHands.size > 0) return;

    const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const CONSOLIDATION_MSG_THRESHOLD = 50;

    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";
    const checkpointPath = join(memRoot, ".consolidation-checkpoint");

    this.consolidating = true;

    (async () => {
      // Load checkpoint
      let lastTs = this.lastConsolidationTs;
      let lastMsgCount = 0;
      try {
        const raw = await this.shell.readFile(checkpointPath);
        const parsed = JSON.parse(raw);
        if (parsed.ts > lastTs) lastTs = parsed.ts;
        lastMsgCount = parsed.msgCount ?? 0;
      } catch { /* no checkpoint */ }

      // Gate 1: time
      if (Date.now() - lastTs < CONSOLIDATION_INTERVAL_MS) {
        this.consolidating = false;
        return;
      }

      // Gate 2: message count
      const allMessages = await this.session.readAll();
      if (allMessages.length - lastMsgCount < CONSOLIDATION_MSG_THRESHOLD) {
        this.consolidating = false;
        return;
      }

      // Dispatch consolidation Hand
      const taskId = generateId();
      const task: TaskDispatch = {
        taskId,
        description: [
          "Consolidate memory files. Read all files in the memory directory,",
          "merge duplicates, remove outdated information, and organize into",
          "clean, well-structured files. Do NOT delete files — update them in place.",
          `Memory directory: ${memRoot}/`,
          `Read ${memRoot}/MEMORY.md for the current index.`,
        ].join("\n"),
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

      // Fire-and-forget: Hand runs independently, resets flag when done
      hand.run()
        .then(async () => {
          const checkpoint = JSON.stringify({
            ts: Date.now(),
            msgCount: allMessages.length,
          });
          await this.shell.writeFile(checkpointPath, checkpoint);
          this.lastConsolidationTs = Date.now();
        })
        .catch(() => { /* consolidation failed — try again next cycle */ })
        .finally(() => { this.consolidating = false; });
    })().catch(() => { this.consolidating = false; });
  }
}
