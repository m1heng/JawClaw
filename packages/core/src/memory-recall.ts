import type { ChatMessage } from "./types.js";
import type { LLMClient } from "./llm.js";
import type { Shell } from "./providers/shell.js";

export type MemoryRecallConfig = {
  maxFiles?: number;          // max files to inject, default 5
  indexPreviewChars?: number; // chars per file in index, default 200
  maxTotalChars?: number;     // total injection budget, default 8000
};

/**
 * Build a compact index of memory files for LLM selection.
 * Lists each file with a content preview.
 */
export async function buildMemoryIndex(
  shell: Shell,
  memoryRoot: string,
  opts?: { previewChars?: number },
): Promise<string> {
  const previewChars = opts?.previewChars ?? 200;
  const files = await shell.listFiles(memoryRoot);
  if (files.length === 0) return "";

  const entries: string[] = [];
  for (const filePath of files) {
    // Skip hidden files (checkpoints etc) and non-markdown
    const name = filePath.split("/").pop() ?? filePath;
    if (name.startsWith(".")) continue;

    try {
      const content = await shell.readFile(filePath);
      const preview = content.slice(0, previewChars).replace(/\n/g, " ").trim();
      entries.push(`- ${filePath}: ${preview}`);
    } catch {
      // Skip unreadable files
    }
  }
  return entries.join("\n");
}

/**
 * Use LLM to select the most relevant memory files for the current context.
 * Returns file paths ranked by relevance.
 */
export async function selectRelevantMemories(params: {
  index: string;
  recentMessages: ChatMessage[];
  llm: LLMClient;
  model: string;
  maxFiles?: number;
}): Promise<string[]> {
  const { index, recentMessages, llm, model, maxFiles = 5 } = params;

  const recentContext = recentMessages
    .slice(-10)
    .map(m => `[${m.role}] ${m.content.slice(0, 200)}`)
    .join("\n");

  const prompt = `Given these memory files:\n${index}\n\nAnd the current conversation:\n${recentContext}\n\nReturn the file paths of the ${maxFiles} most relevant memory files, one per line. Return ONLY file paths, nothing else. If fewer than ${maxFiles} are relevant, return only the relevant ones.`;

  const response = await llm.createCompletion({
    model,
    messages: [
      { role: "system", content: "You select relevant memory files. Output only file paths, one per line." },
      { role: "user", content: prompt },
    ],
  });

  const content = response.content ?? "";
  return content
    .split("\n")
    .map(line => line.trim().replace(/^-\s*/, ""))
    .filter(line => line.length > 0)
    .slice(0, maxFiles);
}

/**
 * Full recall pipeline: build index -> LLM select -> read files -> return content.
 * Returns formatted string ready for system prompt injection.
 * Returns empty string if memory is empty or has fewer than 3 files.
 */
export async function recallMemories(params: {
  shell: Shell;
  memoryRoot: string;
  recentMessages: ChatMessage[];
  llm: LLMClient;
  model: string;
  config?: MemoryRecallConfig;
}): Promise<string> {
  const { shell, memoryRoot, recentMessages, llm, model, config } = params;
  const maxFiles = config?.maxFiles ?? 5;
  const maxTotal = config?.maxTotalChars ?? 8000;

  // Build index
  const index = await buildMemoryIndex(shell, memoryRoot, {
    previewChars: config?.indexPreviewChars,
  });

  // Skip if too few files (not worth the LLM call)
  const fileCount = index.split("\n").filter(l => l.trim()).length;
  if (fileCount < 3) return "";

  // Select relevant files
  const selectedPaths = await selectRelevantMemories({
    index,
    recentMessages,
    llm,
    model,
    maxFiles,
  });

  if (selectedPaths.length === 0) return "";

  // Read selected files and concatenate (only allow paths under memoryRoot)
  const sections: string[] = [];
  let totalChars = 0;
  const normalizedRoot = memoryRoot.endsWith("/") ? memoryRoot : memoryRoot + "/";

  for (const filePath of selectedPaths) {
    if (totalChars >= maxTotal) break;
    // Validate path is under memoryRoot to prevent reading arbitrary files
    if (!filePath.startsWith(normalizedRoot) && filePath !== memoryRoot) continue;
    try {
      const content = await shell.readFile(filePath);
      const budget = maxTotal - totalChars;
      const trimmed = content.length > budget ? content.slice(0, budget) + "\n[truncated]" : content;
      const name = filePath.split("/").pop() ?? filePath;
      sections.push(`### ${name}\n${trimmed}`);
      totalChars += trimmed.length;
    } catch {
      // File disappeared between index and read — skip
    }
  }

  return sections.length > 0 ? "## Recalled Memories\n\n" + sections.join("\n\n") : "";
}
