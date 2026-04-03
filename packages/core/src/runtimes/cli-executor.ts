import type { TaskDispatch, TaskResult } from "../types.js";
import type { HandExecutor, ExecutionContext } from "../runtime.js";
import { shellEscape } from "../shell-escape.js";

export type CLIExecutorConfig = {
  /** Display name, e.g. "claude-code". */
  name: string;
  /** CLI command, e.g. "claude". */
  command: string;
  /** Build CLI args from a task dispatch. */
  buildArgs: (task: TaskDispatch) => string[];
  /** Parse CLI stdout + exitCode into a partial TaskResult. */
  parseOutput: (
    stdout: string,
    exitCode: number,
  ) => Pick<TaskResult, "status" | "summary" | "error">;
  /** Timeout in ms. Default: 600_000 (10 min). */
  timeout?: number;
  /** Extra environment variables for the CLI process. */
  env?: Record<string, string>;
};

/**
 * CLIExecutor — runs an external coding CLI (Claude Code, Codex, Aider, etc.)
 * as the Hand agent via Shell.exec().
 *
 * The CLI is a black box: no per-step checkpoint, no sendMessage,
 * no cron access. Results flow back through Mouth.
 */
export class CLIExecutor implements HandExecutor {
  readonly name: string;

  constructor(private opts: CLIExecutorConfig) {
    this.name = opts.name;
  }

  async execute(
    task: TaskDispatch,
    ctx: ExecutionContext,
  ): Promise<TaskResult> {
    const args = this.opts.buildArgs(task);

    // Build the command string with proper quoting
    const cmd = [this.opts.command, ...args].join(" ");

    // Build env string prefix if needed
    const envPrefix = this.opts.env
      ? Object.entries(this.opts.env)
          .map(([k, v]) => `${k}=${shellEscape(v)}`)
          .join(" ") + " "
      : "";

    const { stdout, stderr, exitCode } = await ctx.shell.exec(
      `${envPrefix}${cmd}`,
      { timeout: this.opts.timeout ?? 600_000, signal: ctx.signal },
    );

    const parsed = this.opts.parseOutput(stdout, exitCode);

    // If parseOutput didn't provide error info, use stderr
    if (parsed.status === "failed" && !parsed.error && stderr) {
      parsed.error = stderr.slice(-2000);
    }

    return {
      taskId: task.taskId,
      ...parsed,
    };
  }
}
