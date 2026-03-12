import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import type { ToolRegistry } from "./tool-executor.js";

/** Ensure resolved path stays within root. Throws on traversal attempt. */
function assertWithin(root: string, filePath: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, filePath);
  const rel = relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith("..") || resolve(resolvedRoot, rel) !== resolved) {
    throw new Error("Path traversal denied");
  }
  return resolved;
}

/**
 * Create memory tool handlers. Shared by both Mouth and Hand agents.
 */
export function createMemoryTools(memoryRoot: string): ToolRegistry {
  return {
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

    memory_write: async (args) => {
      const name = args.name as string;
      const content = args.content as string;
      try {
        const filePath = assertWithin(memoryRoot, name);
        await mkdir(memoryRoot, { recursive: true });
        await writeFile(filePath, content, "utf-8");
        return `Memory written: ${filePath}`;
      } catch (err) {
        return errMsg("memory_write", err);
      }
    },

    memory_read: async (args) => {
      const name = args.name as string;
      try {
        const filePath = assertWithin(memoryRoot, name);
        return await readFile(filePath, "utf-8");
      } catch (err) {
        return errMsg("memory_read", err);
      }
    },

    memory_list: async () => {
      try {
        const files = await collectFiles(memoryRoot);
        if (files.length === 0) return "(no memory files)";
        return files.join("\n");
      } catch {
        return "(memory directory does not exist)";
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
