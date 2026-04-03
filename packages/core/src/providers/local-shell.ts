import { exec } from "node:child_process";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  appendFile as fsAppendFile,
  mkdir as fsMkdir,
  readdir as fsReaddir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Shell, ExecResult } from "./shell.js";

export class LocalShell implements Shell {
  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    const timeout = opts?.timeout ?? 120_000;
    return new Promise((resolve) => {
      const child = exec(
        command,
        { timeout, maxBuffer: 10 * 1024 * 1024, cwd: opts?.cwd },
        (err, stdout, stderr) => {
          resolve({
            exitCode: err ? (err.code ?? 1) : 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );

      if (opts?.signal) {
        const onAbort = () => { child.kill(); };
        if (opts.signal.aborted) {
          child.kill();
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
          child.on("exit", () => opts.signal!.removeEventListener("abort", onAbort));
        }
      }
    });
  }

  async readFile(path: string): Promise<string> {
    return fsReadFile(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    await fsWriteFile(path, content, "utf-8");
  }

  async appendFile(path: string, content: string): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    await fsAppendFile(path, content, "utf-8");
  }

  async mkdir(path: string): Promise<void> {
    await fsMkdir(path, { recursive: true });
  }

  async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fsReaddir(dir, {
        withFileTypes: true,
        recursive: true,
      });
      return entries
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath ?? dir, e.name));
    } catch {
      return [];
    }
  }
}
