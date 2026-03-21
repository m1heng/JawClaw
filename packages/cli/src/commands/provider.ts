import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "../config.js";

export async function handleProvider(subcmd?: string) {
  if (subcmd === "add") {
    await addProvider();
  } else if (subcmd === "remove") {
    await removeProvider();
  } else {
    console.log("Usage:");
    console.log("  jawclaw provider add      Add or update LLM provider");
    console.log("  jawclaw provider remove   Remove LLM provider");
  }
}

async function addProvider() {
  const config = await loadConfig();
  if (!config) {
    console.log("Run jawclaw first to set up.");
    return;
  }

  const providerType = await p.select({
    message: "LLM Provider",
    initialValue: config.provider.type,
    options: [
      { value: "openai", label: "OpenAI (or compatible)" },
      { value: "anthropic", label: "Anthropic Claude" },
      { value: "gemini", label: "Google Gemini" },
    ],
  });
  if (p.isCancel(providerType)) process.exit(0);

  const result = await p.group(
    {
      apiKey: () =>
        p.text({
          message: "API Key",
          initialValue: config.provider.apiKey,
          validate: (v) => (!v || v.length < 5 ? "Key too short" : undefined),
        }),
      baseUrl: () =>
        providerType === "openai"
          ? p.text({
              message: "Base URL (leave empty for OpenAI)",
              defaultValue: config.provider.baseUrl ?? "",
            })
          : Promise.resolve(""),
      mouthModel: () =>
        p.text({
          message: "Mouth model (fast, for chat)",
          initialValue: config.provider.mouthModel,
        }),
      handModel: () =>
        p.text({
          message: "Hand model (strong, for tasks)",
          initialValue: config.provider.handModel,
        }),
    },
    { onCancel: () => process.exit(0) },
  );

  config.provider = {
    type: providerType as string,
    apiKey: result.apiKey as string,
    baseUrl: (result.baseUrl as string) || undefined,
    mouthModel: result.mouthModel as string,
    handModel: result.handModel as string,
  };

  await saveConfig(config);
  console.log("✅ Provider updated");
}

async function removeProvider() {
  console.log("Cannot remove the only provider. Use 'jawclaw provider add' to change it.");
}
