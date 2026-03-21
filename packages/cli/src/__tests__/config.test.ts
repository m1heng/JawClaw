import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, saveConfig } from "../config.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config", () => {
  let origCwd: string;
  let tempDir: string;

  beforeEach(async () => {
    origCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "jawclaw-test-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await rm(tempDir, { recursive: true });
  });

  it("loadConfig returns null when no config", async () => {
    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it("saveConfig + loadConfig round-trips", async () => {
    const config = {
      provider: {
        type: "openai",
        apiKey: "sk-test",
        baseUrl: undefined,
        mouthModel: "gpt-5.4-mini",
        handModel: "gpt-5.4",
      },
      channels: [{ type: "telegram", token: "123:ABC" }],
    };

    await saveConfig(config);
    const loaded = await loadConfig();

    expect(loaded).not.toBeNull();
    expect(loaded!.provider.apiKey).toBe("sk-test");
    expect(loaded!.provider.mouthModel).toBe("gpt-5.4-mini");
    expect(loaded!.channels).toHaveLength(1);
    expect(loaded!.channels[0].type).toBe("telegram");
  });

  it("saveConfig creates directory and writes JSON", async () => {
    await saveConfig({
      provider: { type: "openai", apiKey: "k", mouthModel: "m", handModel: "h" },
      channels: [],
    });

    const raw = await readFile(".jawclaw/config.json", "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.provider.type).toBe("openai");
  });

  it("saveConfig overwrites existing config", async () => {
    await saveConfig({
      provider: { type: "openai", apiKey: "old", mouthModel: "m", handModel: "h" },
      channels: [],
    });
    await saveConfig({
      provider: { type: "anthropic", apiKey: "new", mouthModel: "m2", handModel: "h2" },
      channels: [{ type: "telegram", token: "t" }],
    });

    const loaded = await loadConfig();
    expect(loaded!.provider.type).toBe("anthropic");
    expect(loaded!.provider.apiKey).toBe("new");
    expect(loaded!.channels).toHaveLength(1);
  });
});
