import { join } from "node:path";
import { generateId } from "./id.js";
import { ChatSession } from "./chat-session.js";
import { MessageQueue } from "./message-queue.js";
import { HandAgent } from "./hand-agent.js";
import { createMemoryTools } from "./memory-tools.js";
import { runReactLoop } from "./react-loop.js";
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
- Use memory tools to read/write shared knowledge (user preferences, project context)

Rules:
- NEVER try to execute coding tasks yourself — always dispatch to Hand Agents
- Check memory for relevant context before dispatching tasks
- Write important user preferences or project context to memory
- Be concise and friendly
- For simple greetings or questions about yourself, respond directly without dispatching
- You may receive multiple user messages at once — read them all before responding`;

const HAND_SYSTEM_PROMPT = `You are a Hand Agent (Claw) of JawClaw. You execute coding tasks.

Your job:
- Execute the task described in your initial message
- Use tools to read files, run commands, write/edit files, search, and gather information
- Provide a clear, concise summary when done

Available context:
- Use read_source_chat to see the original IM conversation for more context
- You have access to the workspace files and shared memory

Tools available:
- File ops: read_file, write_file, edit_file, list_files, grep
- Commands: run_command
- Web: web_search
- Messaging: message (send to IM channels)
- Scheduling: cron (schedule/list/delete tasks)
- Memory: memory_query, memory_read, memory_write, memory_list

Rules:
- Stay focused on your assigned task
- Be thorough but efficient
- Your final message will be shown directly to the user, so make it clear and useful`;

/** Max messages to batch-drain per react loop cycle. */
const MAX_BATCH = 5;


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
  }

  private async runOnce(): Promise<void> {
    const sendReply = this.sendReply!;
    const memRoot = this.handServices.memoryRoot ?? ".jawclaw/memory";

    const tools: ToolRegistry = {
      ...createMemoryTools(memRoot),

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
      config: this.config,
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
}
