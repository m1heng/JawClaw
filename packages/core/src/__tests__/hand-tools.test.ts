import { describe, it, expect, beforeEach } from "vitest";
import { createHandTools } from "../hand-tools.js";
import { MockShell } from "./fixtures/mock-shell.js";
import type { HandServices } from "../types.js";

describe("createHandTools", () => {
  let shell: MockShell;
  let services: HandServices;
  let tools: ReturnType<typeof createHandTools>;

  beforeEach(() => {
    shell = new MockShell();
    services = {};
    tools = createHandTools(shell, services);
  });

  describe("write_file", () => {
    it("writes content through shell", async () => {
      const result = await tools.write_file({ path: "/tmp/test.txt", content: "hello" });
      expect(result).toContain("File written");
      expect(shell.files.get("/tmp/test.txt")).toBe("hello");
    });
  });

  describe("edit_file", () => {
    it("replaces exact match", async () => {
      shell.files.set("/tmp/f.txt", "foo bar baz");
      const result = await tools.edit_file({
        path: "/tmp/f.txt",
        old_string: "bar",
        new_string: "qux",
      });
      expect(result).toContain("File edited");
      expect(shell.files.get("/tmp/f.txt")).toBe("foo qux baz");
    });

    it("errors on no match", async () => {
      shell.files.set("/tmp/f.txt", "hello");
      const result = await tools.edit_file({
        path: "/tmp/f.txt",
        old_string: "missing",
        new_string: "x",
      });
      expect(result).toContain("not found");
    });

    it("errors on multiple matches", async () => {
      shell.files.set("/tmp/f.txt", "aaa aaa");
      const result = await tools.edit_file({
        path: "/tmp/f.txt",
        old_string: "aaa",
        new_string: "bbb",
      });
      expect(result).toContain("2 times");
    });

    it("errors on missing file", async () => {
      const result = await tools.edit_file({
        path: "/tmp/nope.txt",
        old_string: "x",
        new_string: "y",
      });
      expect(result).toContain("Error");
    });
  });

  describe("run_command", () => {
    it("returns formatted output", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "ok\n", stderr: "" });
      const result = await tools.run_command({ command: "echo ok" });
      expect(result).toContain("ok");
    });

    it("includes exit code on failure", async () => {
      shell.execHandler = () => ({ exitCode: 1, stdout: "", stderr: "fail" });
      const result = await tools.run_command({ command: "bad" });
      expect(result).toContain("exit code 1");
      expect(result).toContain("fail");
    });

    it("passes cwd and timeout", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "", stderr: "" });
      await tools.run_command({ command: "ls", cwd: "/tmp", timeout: 5000 });
      expect(shell.execCalls[0].opts?.cwd).toBe("/tmp");
      expect(shell.execCalls[0].opts?.timeout).toBe(5000);
    });
  });

  describe("web_search", () => {
    it("returns error when not configured", async () => {
      const result = await tools.web_search({ query: "test" });
      expect(result).toContain("not configured");
    });

    it("delegates to service when configured", async () => {
      services.webSearch = async (q) => `Results for: ${q}`;
      tools = createHandTools(shell, services);
      const result = await tools.web_search({ query: "test" });
      expect(result).toBe("Results for: test");
    });
  });

  describe("message", () => {
    it("returns error when not configured", async () => {
      const result = await tools.message({ chat_id: "1", text: "hi" });
      expect(result).toContain("not available");
    });

    it("sends message when configured", async () => {
      let sent = "";
      services.sendMessage = async (_id, text) => { sent = text; };
      tools = createHandTools(shell, services);
      const result = await tools.message({ chat_id: "1", text: "hi" });
      expect(result).toContain("Message sent");
      expect(sent).toBe("hi");
    });
  });

  describe("cron", () => {
    it("returns error when not configured", async () => {
      const result = await tools.cron({ action: "list" });
      expect(result).toContain("not configured");
    });

    it("lists entries when configured", async () => {
      services.cronList = () => [
        { id: "c1", description: "test", cronExpr: "*/5 * * * *", nextRun: "soon" },
      ];
      tools = createHandTools(shell, services);
      const result = await tools.cron({ action: "list" });
      expect(result).toContain("c1");
      expect(result).toContain("test");
    });

    it("returns empty message when no entries", async () => {
      services.cronList = () => [];
      tools = createHandTools(shell, services);
      const result = await tools.cron({ action: "list" });
      expect(result).toContain("no scheduled");
    });

    it("deletes entry", async () => {
      services.cronDelete = (id) => id === "c1";
      tools = createHandTools(shell, services);
      expect(await tools.cron({ action: "delete", id: "c1" })).toContain("Deleted");
      expect(await tools.cron({ action: "delete", id: "c2" })).toContain("not found");
    });

    it("schedules with replyTo", async () => {
      let scheduledChat = "";
      services.cronSchedule = (_d, _c, chatId) => { scheduledChat = chatId; return "id1"; };
      tools = createHandTools(shell, services, "chat-123");
      const result = await tools.cron({
        action: "schedule",
        description: "remind",
        cron_expr: "*/5 * * * *",
      });
      expect(result).toContain("Scheduled");
      expect(scheduledChat).toBe("chat-123");
    });

    it("errors on unknown action", async () => {
      const result = await tools.cron({ action: "bogus" });
      expect(result).toContain("unknown cron action");
    });
  });
});
