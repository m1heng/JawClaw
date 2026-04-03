import type { TaskDispatch } from "../types.js";
import type { CLIExecutorConfig } from "./cli-executor.js";
import { shellEscape } from "../shell-escape.js";

type CLIPreset = Omit<CLIExecutorConfig, "name">;

/**
 * Preset configurations for known coding CLIs.
 *
 * Each preset defines how to build args and parse output.
 * Users can override individual fields in config.json.
 */
export const CLI_PRESETS: Record<string, CLIPreset> = {
  "claude-code": {
    command: "claude",
    buildArgs: (task: TaskDispatch) => [
      "-p",
      shellEscape(
        task.description +
          `\n\nContext: read ${task.sourceChat} for conversation history`,
      ),
      "--output-format",
      "json",
    ],
    parseOutput: (stdout, exitCode) => {
      if (exitCode !== 0) {
        return {
          status: "failed",
          summary: "",
          error: `claude exited with code ${exitCode}`,
        };
      }
      try {
        const parsed = JSON.parse(stdout);
        return {
          status: "completed",
          summary:
            parsed.result ?? parsed.response ?? stdout.slice(-2000),
        };
      } catch {
        return { status: "completed", summary: stdout.slice(-2000) };
      }
    },
  },

  codex: {
    command: "codex",
    buildArgs: (task: TaskDispatch) => [
      "--quiet",
      shellEscape(task.description),
    ],
    parseOutput: (stdout, exitCode) => ({
      status: exitCode === 0 ? "completed" : "failed",
      summary: stdout.slice(-2000),
      error:
        exitCode !== 0
          ? `codex exited with code ${exitCode}`
          : undefined,
    }),
  },

  aider: {
    command: "aider",
    buildArgs: (task: TaskDispatch) => [
      "--yes",
      "--message",
      shellEscape(task.description),
    ],
    parseOutput: (stdout, exitCode) => ({
      status: exitCode === 0 ? "completed" : "failed",
      summary: stdout.slice(-2000),
      error:
        exitCode !== 0
          ? `aider exited with code ${exitCode}`
          : undefined,
    }),
  },
};
