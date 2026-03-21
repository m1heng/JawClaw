import * as p from "@clack/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import { saveConfig } from "./config.js";
import type { Config } from "./config.js";

const DEFAULT_SOUL = `# Soul

You are a helpful coding assistant connected via instant messaging.
You are friendly, concise, and focused on getting things done.
`;

const DEFAULT_INSTRUCTIONS = `# Instructions

- When a user asks you to do something, dispatch it to a Hand Agent
- For simple questions or greetings, reply directly
- Use memory to track project context and user preferences
- Keep replies concise — this is IM, not email
`;

export async function onboard(): Promise<Config> {
  p.intro("🐾 JawClaw — first time setup");

  const providerType = await p.select({
    message: "LLM Provider",
    options: [
      { value: "openai", label: "OpenAI (or compatible)" },
      { value: "anthropic", label: "Anthropic Claude" },
      { value: "gemini", label: "Google Gemini" },
    ],
  });
  if (p.isCancel(providerType)) process.exit(0);

  const provider = await p.group(
    {
      apiKey: () =>
        p.text({
          message: "API Key",
          placeholder: providerType === "openai" ? "sk-..." : "...",
          validate: (v) => (!v || v.length < 5 ? "Key too short" : undefined),
        }),
      baseUrl: () =>
        providerType === "openai"
          ? p.text({
              message: "Base URL (leave empty for OpenAI)",
              placeholder: "https://api.openai.com/v1",
              defaultValue: "",
            })
          : Promise.resolve(""),
    },
    { onCancel: () => process.exit(0) },
  );

  const channel = await p.group(
    {
      token: () =>
        p.text({
          message: "Telegram Bot Token",
          placeholder: "123456:ABC-DEF...",
          validate: (v) =>
            v?.includes(":") ? undefined : "Should contain ':'",
        }),
    },
    { onCancel: () => process.exit(0) },
  );

  const defaultModels: Record<string, { mouth: string; hand: string }> = {
    openai: { mouth: "gpt-4o-mini", hand: "gpt-4o" },
    anthropic: { mouth: "claude-sonnet-4-20250514", hand: "claude-sonnet-4-20250514" },
    gemini: { mouth: "gemini-2.5-flash", hand: "gemini-2.5-pro" },
  };
  const models = defaultModels[providerType as string] ?? defaultModels.openai;

  const config: Config = {
    provider: {
      type: providerType as string,
      apiKey: provider.apiKey as string,
      baseUrl: (provider.baseUrl as string) || undefined,
      mouthModel: models.mouth,
      handModel: models.hand,
    },
    channels: [{ type: "telegram", token: channel.token as string }],
  };

  // Save config
  await saveConfig(config);

  // Create directory structure + template files
  await mkdir(".jawclaw/memory/contacts", { recursive: true });
  await mkdir(".jawclaw/sessions", { recursive: true });

  await writeIfMissing(".jawclaw/SOUL.md", DEFAULT_SOUL);
  await writeIfMissing(".jawclaw/INSTRUCTIONS.md", DEFAULT_INSTRUCTIONS);

  p.outro("✅ Setup complete — starting bot...");

  return config;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    // File exists, don't overwrite
  } catch {
    await writeFile(path, content, "utf-8");
  }
}
