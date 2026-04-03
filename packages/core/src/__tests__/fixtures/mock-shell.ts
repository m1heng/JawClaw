import type { Shell, ExecResult } from "../../providers/shell.js";

/**
 * In-memory Shell implementation for testing.
 * All file operations happen in a Map, exec calls are recorded.
 */
export class MockShell implements Shell {
  files = new Map<string, string>();
  execCalls: Array<{ command: string; opts?: { cwd?: string; timeout?: number; signal?: AbortSignal } }> = [];
  execHandler?: (command: string) => ExecResult;

  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.execCalls.push({ command, opts });
    if (this.execHandler) return this.execHandler(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    const existing = this.files.get(path) ?? "";
    this.files.set(path, existing + content);
  }

  async mkdir(_path: string): Promise<void> {
    // no-op in memory
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(dir));
  }
}
