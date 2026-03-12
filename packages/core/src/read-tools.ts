import { exec } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRegistry } from "./tool-executor.js";

/** Shell-escape a string for safe interpolation. */
function esc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Run a shell command, returning combined stdout+stderr. */
function run(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
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

/**
 * Create READ group tool handlers.
 * Shared by both Mouth and Hand agents (SSOT).
 */
export function createReadTools(memoryRoot: string): ToolRegistry {
  return {
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

    grep: async (args) => {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? ".";
      const glob = args.glob as string | undefined;
      const includeFlag = glob ? `--include=${esc(glob)}` : "";
      const result = await run(
        `grep -rn ${includeFlag} -E ${esc(pattern)} ${esc(searchPath)} 2>/dev/null | head -100`,
      );
      return result || "(no matches)";
    },

    glob: async (args) => {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? ".";
      let cmd: string;
      if (pattern.includes("/")) {
        // Path pattern: use find -path (where * matches across /)
        const findPattern = `${searchPath}/${pattern}`.replace(/\*\*/g, "*");
        cmd = `find ${esc(searchPath)} -type f -path ${esc(findPattern)} 2>/dev/null | head -200`;
      } else {
        cmd = `find ${esc(searchPath)} -type f -name ${esc(pattern)} 2>/dev/null | head -200`;
      }
      const result = await run(cmd);
      return result || "(no files found)";
    },

    memory_query: async (args) => {
      const query = args.query as string;
      try {
        const files = await collectFiles(memoryRoot);
        if (files.length === 0) return "(no memory files found)";

        const regex = new RegExp(query, "i");
        const results: string[] = [];
        for (const file of files) {
          const content = await readFile(file, "utf-8");
          const lines = content.split("\n");
          const matches = lines
            .map((line, i) => ({ line, num: i + 1 }))
            .filter((l) => regex.test(l.line));
          if (matches.length > 0) {
            results.push(
              `--- ${file} ---\n` +
                matches.map((m) => `${m.num}: ${m.line}`).join("\n"),
            );
          }
        }
        return results.length > 0
          ? results.join("\n\n")
          : `(no matches for "${query}" in memory)`;
      } catch (err) {
        return errMsg("memory_query", err);
      }
    },
  };
}

function errMsg(tool: string, err: unknown): string {
  return `Error in ${tool}: ${err instanceof Error ? err.message : String(err)}`;
}

async function collectFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath ?? dir, e.name));
  } catch {
    return [];
  }
}
