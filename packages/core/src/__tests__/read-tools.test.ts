import { describe, it, expect, beforeEach } from "vitest";
import { createReadTools } from "../read-tools.js";
import { MockShell } from "./fixtures/mock-shell.js";

describe("createReadTools", () => {
  let shell: MockShell;
  let tools: ReturnType<typeof createReadTools>;

  beforeEach(() => {
    shell = new MockShell();
    tools = createReadTools(shell, "/mem");
  });

  describe("read_file", () => {
    it("returns file content", async () => {
      shell.files.set("/tmp/a.txt", "line1\nline2\nline3");
      const result = await tools.read_file({ path: "/tmp/a.txt" });
      expect(result).toBe("line1\nline2\nline3");
    });

    it("returns error for missing file", async () => {
      const result = await tools.read_file({ path: "/nope" });
      expect(result).toContain("Error");
      expect(result).toContain("ENOENT");
    });

    it("supports offset and limit", async () => {
      shell.files.set("/tmp/a.txt", "a\nb\nc\nd\ne");
      const result = await tools.read_file({ path: "/tmp/a.txt", offset: 2, limit: 2 });
      // offset=2 means start at line 2 (1-based), limit=2 means 2 lines
      expect(result).toContain("2\tb");
      expect(result).toContain("3\tc");
      expect(result).not.toContain("4\td");
    });
  });

  describe("grep", () => {
    it("calls shell exec with escaped pattern", async () => {
      shell.execHandler = () => ({
        exitCode: 0,
        stdout: "/tmp/a.txt:1:match here",
        stderr: "",
      });
      const result = await tools.grep({ pattern: "match", path: "/tmp" });
      expect(result).toContain("match here");
      expect(shell.execCalls[0].command).toContain("grep");
      expect(shell.execCalls[0].command).toContain("match");
    });

    it("returns no matches on empty successful output", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "", stderr: "" });
      const result = await tools.grep({ pattern: "xyz" });
      expect(result).toContain("no matches");
    });

    it("supports glob filter", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "found", stderr: "" });
      await tools.grep({ pattern: "x", glob: "*.ts" });
      expect(shell.execCalls[0].command).toContain("--include");
      expect(shell.execCalls[0].command).toContain("*.ts");
    });
  });

  describe("glob", () => {
    it("calls find for simple pattern", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "/a.ts\n/b.ts\n", stderr: "" });
      const result = await tools.glob({ pattern: "*.ts" });
      expect(result).toContain("/a.ts");
      expect(shell.execCalls[0].command).toContain("find");
      expect(shell.execCalls[0].command).toContain("-name");
    });

    it("uses -path for patterns with /", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "/src/a.ts\n", stderr: "" });
      await tools.glob({ pattern: "src/**/*.ts" });
      expect(shell.execCalls[0].command).toContain("-path");
    });

    it("returns no files found on empty", async () => {
      shell.execHandler = () => ({ exitCode: 0, stdout: "", stderr: "" });
      const result = await tools.glob({ pattern: "*.xyz" });
      expect(result).toContain("no files found");
    });
  });

  describe("memory_query", () => {
    it("searches memory files by regex", async () => {
      shell.files.set("/mem/note.md", "The project uses TypeScript.\nIt also uses React.");
      const result = await tools.memory_query({ query: "TypeScript" });
      expect(result).toContain("note.md");
      expect(result).toContain("TypeScript");
    });

    it("returns no matches when nothing found", async () => {
      shell.files.set("/mem/note.md", "hello world");
      const result = await tools.memory_query({ query: "xyz123" });
      expect(result).toContain("no matches");
    });

    it("returns no memory files when dir is empty", async () => {
      const result = await tools.memory_query({ query: "anything" });
      expect(result).toContain("no memory files");
    });

    it("searches case-insensitively", async () => {
      shell.files.set("/mem/note.md", "Hello World");
      const result = await tools.memory_query({ query: "hello" });
      expect(result).toContain("Hello World");
    });

    it("shows line numbers", async () => {
      shell.files.set("/mem/note.md", "aaa\nbbb\nccc");
      const result = await tools.memory_query({ query: "bbb" });
      expect(result).toContain("2: bbb");
    });
  });
});
