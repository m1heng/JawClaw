import * as p from "@clack/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import { initRegistry, listChannels, getChannel } from "@jawclaw/channels";
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

export async function onboard(existingConfig?: Config | null): Promise<Config> {
  p.intro("🐾 JawClaw — first time setup");

  const providerType = await p.select({
    message: "LLM Provider",
    options: [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic Claude" },
      { value: "gemini", label: "Google Gemini" },
      { value: "openai-compatible", label: "OpenAI-compatible (custom endpoint)" },
    ],
  });
  if (p.isCancel(providerType)) process.exit(0);

  const needsBaseUrl = providerType === "openai-compatible";

  const provider = await p.group(
    {
      apiKey: () =>
        p.text({
          message: "API Key",
          placeholder: providerType === "openai" ? "sk-..." : "...",
          validate: (v) => (!v || v.length < 5 ? "Key too short" : undefined),
        }),
      baseUrl: () =>
        needsBaseUrl
          ? p.text({
              message: "Base URL",
              placeholder: "https://your-endpoint.com/v1",
              validate: (v) => (!v ? "Base URL is required" : undefined),
            })
          : Promise.resolve(""),
    },
    { onCancel: () => process.exit(0) },
  );

  // Channel selection — driven by registry (includes external extensions if config exists)
  await initRegistry(existingConfig?.extensions);
  const extensions = listChannels();

  const channelType = await p.select({
    message: "Channel type",
    options: extensions.map((e) => ({ value: e.name, label: e.label })),
  });
  if (p.isCancel(channelType)) process.exit(0);

  const ext = getChannel(channelType as string)!;
  const channelAnswers: Record<string, string> = {};

  for (const field of ext.configFields) {
    const val = await p.text({
      message: field.label,
      placeholder: field.placeholder,
      validate: field.required ? (v) => (!v ? "Required" : undefined) : undefined,
    });
    if (p.isCancel(val)) process.exit(0);
    channelAnswers[field.key] = val as string;
  }

  const defaultModels: Record<string, { mouth: string; hand: string }> = {
    openai: { mouth: "gpt-5.4-mini", hand: "gpt-5.4" },
    anthropic: { mouth: "claude-sonnet-4-6", hand: "claude-opus-4-6" },
    gemini: { mouth: "gemini-2.5-flash", hand: "gemini-2.5-pro" },
  };

  let models = defaultModels[providerType as string];

  // OpenAI-compatible: ask for model names since we can't guess
  if (!models) {
    const customModels = await p.group(
      {
        mouth: () =>
          p.text({ message: "Mouth model (fast, for chat)", placeholder: "model-name" }),
        hand: () =>
          p.text({ message: "Hand model (strong, for tasks)", placeholder: "model-name" }),
      },
      { onCancel: () => process.exit(0) },
    );
    models = { mouth: customModels.mouth as string, hand: customModels.hand as string };
  }

  // openai-compatible uses the openai SDK under the hood
  const configType = providerType === "openai-compatible" ? "openai" : (providerType as string);

  const config: Config = {
    provider: {
      type: configType,
      apiKey: provider.apiKey as string,
      baseUrl: (provider.baseUrl as string) || undefined,
      mouthModel: models.mouth,
      handModel: models.hand,
    },
    channels: [{
      type: channelType as string,
      ...channelAnswers,
    }],
    ...(existingConfig?.extensions?.length ? { extensions: existingConfig.extensions } : {}),
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
