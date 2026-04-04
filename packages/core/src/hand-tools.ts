import type { Shell, ExecResult } from "./providers/shell.js";
import type { HandServices } from "./types.js";
import type { ToolRegistry } from "./tool-executor.js";

/** Format an ExecResult as a human-readable string. */
function formatExec(r: ExecResult): string {
  if (r.exitCode !== 0) {
    return `exit code ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
  }
  return r.stdout + (r.stderr ? `\nstderr: ${r.stderr}` : "");
}

export function createHandTools(
  shell: Shell,
  services: HandServices,
  taskReplyTo?: string,
  fileMtimes?: Map<string, number>,
): ToolRegistry {
  return {
    // WRITE group
    write_file: async (args) => {
      const path = args.path as string;
      const content = args.content as string;
      try {
        await shell.writeFile(path, content);
        // Update tracked mtime after write
        if (fileMtimes && shell.stat) {
          try {
            const s = await shell.stat(path);
            fileMtimes.set(path, s.mtimeMs);
          } catch { /* non-fatal */ }
        }
        return `File written: ${path}`;
      } catch (err) {
        return errMsg("write_file", err);
      }
    },

    edit_file: async (args) => {
      const path = args.path as string;
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      try {
        // Staleness check: if we previously read this file, verify it hasn't changed
        if (fileMtimes?.has(path) && shell.stat) {
          try {
            const current = await shell.stat(path);
            const recorded = fileMtimes.get(path)!;
            if (current.mtimeMs !== recorded) {
              return `Error: ${path} was modified since last read. Use read_file to get the latest content before editing.`;
            }
          } catch { /* stat failure → skip check, proceed with edit */ }
        }
        const content = await shell.readFile(path);
        const count = content.split(oldStr).length - 1;
        if (count === 0) return `Error: old_string not found in ${path}`;
        if (count > 1)
          return `Error: old_string appears ${count} times in ${path}. Must be unique.`;
        await shell.writeFile(path, content.replace(oldStr, newStr));
        // Update tracked mtime after successful edit
        if (fileMtimes && shell.stat) {
          try {
            const s = await shell.stat(path);
            fileMtimes.set(path, s.mtimeMs);
          } catch { /* non-fatal */ }
        }
        return `File edited: ${path}`;
      } catch (err) {
        return errMsg("edit_file", err);
      }
    },

    // EXECUTE group
    run_command: async (args) => {
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      const timeout = (args.timeout as number) ?? 120_000;
      const result = await shell.exec(command, { cwd, timeout });
      return formatExec(result);
    },

    // EXTERNAL group
    web_search: async (args) => {
      const query = args.query as string;
      if (!services.webSearch) {
        return "Error: web_search is not configured. Set WEB_SEARCH_PROVIDER.";
      }
      try {
        return await services.webSearch(query);
      } catch (err) {
        return errMsg("web_search", err);
      }
    },

    message: async (args) => {
      const chatId = args.chat_id as string;
      const text = args.text as string;
      if (!services.sendMessage) {
        return "Error: message sending is not available.";
      }
      try {
        await services.sendMessage(chatId, text);
        return `Message sent to ${chatId}.`;
      } catch (err) {
        return errMsg("message", err);
      }
    },

    cron: async (args) => {
      const action = args.action as string;
      if (action === "list") {
        if (!services.cronList) return "Error: cron not configured.";
        const entries = services.cronList();
        if (entries.length === 0) return "(no scheduled tasks)";
        return entries
          .map(
            (e) =>
              `${e.id}  ${e.cronExpr}  ${e.description}  next: ${e.nextRun}`,
          )
          .join("\n");
      }
      if (action === "delete") {
        const id = args.id as string;
        if (!services.cronDelete) return "Error: cron not configured.";
        return services.cronDelete(id)
          ? `Deleted cron ${id}.`
          : `Cron ${id} not found.`;
      }
      if (action === "schedule") {
        const description = args.description as string;
        const cronExpr = args.cron_expr as string;
        if (!description || !cronExpr)
          return "Error: description and cron_expr required for schedule.";
        if (!services.cronSchedule) return "Error: cron not configured.";
        const chatId = taskReplyTo ?? "unknown";
        const id = services.cronSchedule(description, cronExpr, chatId);
        return `Scheduled (${id}): "${description}" with expression "${cronExpr}".`;
      }
      return `Error: unknown cron action "${action}".`;
    },
  };
}

function errMsg(tool: string, err: unknown): string {
  return `Error in ${tool}: ${err instanceof Error ? err.message : String(err)}`;
}
