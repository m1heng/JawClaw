import { HandAgent } from "../hand-agent.js";
import type { TaskDispatch, TaskResult, HandServices, AgentConfig } from "../types.js";
import type { LLMClient } from "../llm.js";
import type { HandExecutor, ExecutionContext } from "../runtime.js";
import type { CheckpointStore } from "../checkpoint.js";

export type BuiltinExecutorConfig = {
  llm: LLMClient;
  config: AgentConfig;
  services: HandServices;
  /** Optional: save session checkpoint after each turn. */
  checkpointStore?: CheckpointStore;
};

export class BuiltinExecutor implements HandExecutor {
  readonly name = "builtin";

  constructor(private opts: BuiltinExecutorConfig) {}

  async execute(
    task: TaskDispatch,
    ctx: ExecutionContext,
  ): Promise<TaskResult> {
    const cpStore = this.opts.checkpointStore;

    const hand = new HandAgent({
      task,
      sessionsDir: ctx.sessionsDir,
      config: this.opts.config,
      llm: this.opts.llm,
      services: this.opts.services,
      shell: ctx.shell,
      abortSignal: ctx.signal,
      skipPrologue: ctx.resuming,
      onTurn: async (turn) => {
        ctx.onProgress({ currentTurn: turn });

        // Checkpoint: persist session JSONL so we can resume on crash
        if (cpStore) {
          const messages = await hand.session.readAll();
          const session = messages
            .map((m) => JSON.stringify(m))
            .join("\n");
          await cpStore.save({
            taskId: task.taskId,
            turn,
            session,
            createdAt: new Date().toISOString(),
          });
        }
      },
    });

    return hand.run();
  }
}
