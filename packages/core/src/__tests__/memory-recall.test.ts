import { describe, it, expect, beforeEach } from "vitest";
import { buildMemoryIndex, selectRelevantMemories, recallMemories } from "../memory-recall.js";
import { MockShell } from "./fixtures/mock-shell.js";
import { MockLLM } from "./fixtures/mock-llm.js";
import type { ChatMessage } from "../types.js";

describe("buildMemoryIndex", () => {
  let shell: MockShell;

  beforeEach(() => {
    shell = new MockShell();
  });

  it("returns empty string for empty memory directory", async () => {
    const result = await buildMemoryIndex(shell, "/mem");
    expect(result).toBe("");
  });

  it("skips hidden files", async () => {
    shell.files.set("/mem/.summary-checkpoint", "42");
    shell.files.set("/mem/.hidden-file", "secret");
    shell.files.set("/mem/note.md", "visible note");

    const result = await buildMemoryIndex(shell, "/mem");
    expect(result).not.toContain(".summary-checkpoint");
    expect(result).not.toContain(".hidden-file");
    expect(result).toContain("note.md");
  });

  it("includes file paths and content previews", async () => {
    shell.files.set("/mem/contacts/alice.md", "Alice is a developer who likes TypeScript.");
    shell.files.set("/mem/MEMORY.md", "# Memory Index\n- contacts/alice.md");

    const result = await buildMemoryIndex(shell, "/mem");
    expect(result).toContain("/mem/contacts/alice.md");
    expect(result).toContain("Alice is a developer");
    expect(result).toContain("/mem/MEMORY.md");
    expect(result).toContain("Memory Index");
  });

  it("respects previewChars option", async () => {
    shell.files.set("/mem/long.md", "A".repeat(500));

    const result = await buildMemoryIndex(shell, "/mem", { previewChars: 50 });
    // The preview should be at most 50 chars of content
    const preview = result.split(": ")[1];
    expect(preview.length).toBeLessThanOrEqual(50);
  });
});

describe("selectRelevantMemories", () => {
  let llm: MockLLM;

  const sampleMessages: ChatMessage[] = [
    { ts: "2025-01-01T00:00:00Z", role: "user", content: "Tell me about Alice" },
  ];

  beforeEach(() => {
    llm = new MockLLM();
  });

  it("parses LLM response into file paths", async () => {
    llm.addTextResponse("/mem/contacts/alice.md\n/mem/MEMORY.md\n/mem/summaries/today.md");

    const result = await selectRelevantMemories({
      index: "- /mem/contacts/alice.md: Alice info\n- /mem/MEMORY.md: index\n- /mem/summaries/today.md: summary",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toEqual(["/mem/contacts/alice.md", "/mem/MEMORY.md", "/mem/summaries/today.md"]);
  });

  it("strips leading '- ' from paths", async () => {
    llm.addTextResponse("- /mem/contacts/alice.md\n- /mem/MEMORY.md");

    const result = await selectRelevantMemories({
      index: "- /mem/contacts/alice.md: Alice\n- /mem/MEMORY.md: index",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toEqual(["/mem/contacts/alice.md", "/mem/MEMORY.md"]);
  });

  it("limits to maxFiles", async () => {
    llm.addTextResponse("/mem/a.md\n/mem/b.md\n/mem/c.md\n/mem/d.md\n/mem/e.md");

    const result = await selectRelevantMemories({
      index: "lots of files",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
      maxFiles: 2,
    });

    expect(result).toHaveLength(2);
    expect(result).toEqual(["/mem/a.md", "/mem/b.md"]);
  });

  it("filters out empty lines", async () => {
    llm.addTextResponse("/mem/a.md\n\n/mem/b.md\n\n");

    const result = await selectRelevantMemories({
      index: "files",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toEqual(["/mem/a.md", "/mem/b.md"]);
  });
});

describe("recallMemories", () => {
  let shell: MockShell;
  let llm: MockLLM;

  const sampleMessages: ChatMessage[] = [
    { ts: "2025-01-01T00:00:00Z", role: "user", content: "What do we know about Alice?" },
  ];

  beforeEach(() => {
    shell = new MockShell();
    llm = new MockLLM();
  });

  it("returns empty string when fewer than 3 files in memory", async () => {
    shell.files.set("/mem/a.md", "content a");
    shell.files.set("/mem/b.md", "content b");

    const result = await recallMemories({
      shell,
      memoryRoot: "/mem",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toBe("");
    // Should NOT have called the LLM
    expect(llm.calls).toHaveLength(0);
  });

  it("returns empty string when memory directory is empty", async () => {
    const result = await recallMemories({
      shell,
      memoryRoot: "/mem",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toBe("");
    expect(llm.calls).toHaveLength(0);
  });

  it("returns formatted content when enough files exist", async () => {
    shell.files.set("/mem/contacts/alice.md", "Alice is a senior engineer.");
    shell.files.set("/mem/contacts/bob.md", "Bob manages the team.");
    shell.files.set("/mem/MEMORY.md", "# Memory\n- contacts/alice.md\n- contacts/bob.md");
    shell.files.set("/mem/summaries/2025-01-01.md", "Session summary: discussed project plans.");

    // LLM selects alice and the summary
    llm.addTextResponse("/mem/contacts/alice.md\n/mem/summaries/2025-01-01.md");

    const result = await recallMemories({
      shell,
      memoryRoot: "/mem",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toContain("## Recalled Memories");
    expect(result).toContain("### alice.md");
    expect(result).toContain("Alice is a senior engineer.");
    expect(result).toContain("### 2025-01-01.md");
    expect(result).toContain("Session summary: discussed project plans.");
  });

  it("respects maxTotalChars budget", async () => {
    const longContent = "X".repeat(5000);
    shell.files.set("/mem/a.md", longContent);
    shell.files.set("/mem/b.md", "Short content.");
    shell.files.set("/mem/c.md", "Also short.");
    shell.files.set("/mem/d.md", "Fourth file.");

    // LLM selects a.md and b.md
    llm.addTextResponse("/mem/a.md\n/mem/b.md");

    const result = await recallMemories({
      shell,
      memoryRoot: "/mem",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
      config: { maxTotalChars: 100 },
    });

    // The total content should be limited
    expect(result).toContain("### a.md");
    expect(result).toContain("[truncated]");
  });

  it("skips files that disappeared between index and read", async () => {
    shell.files.set("/mem/a.md", "content a");
    shell.files.set("/mem/b.md", "content b");
    shell.files.set("/mem/c.md", "content c");

    // LLM selects a file that will be missing
    llm.addTextResponse("/mem/missing.md\n/mem/a.md");

    const result = await recallMemories({
      shell,
      memoryRoot: "/mem",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    // Should still include a.md, skip missing.md
    expect(result).toContain("### a.md");
    expect(result).not.toContain("missing.md");
  });

  it("returns empty string when LLM selects no files", async () => {
    shell.files.set("/mem/a.md", "content a");
    shell.files.set("/mem/b.md", "content b");
    shell.files.set("/mem/c.md", "content c");

    llm.addTextResponse("");

    const result = await recallMemories({
      shell,
      memoryRoot: "/mem",
      recentMessages: sampleMessages,
      llm,
      model: "test-model",
    });

    expect(result).toBe("");
  });
});
