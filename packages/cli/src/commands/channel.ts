import * as p from "@clack/prompts";
import { initRegistry, listChannels, getChannel } from "@jawclaw/channels";
import { loadConfig, saveConfig } from "../config.js";

export async function handleChannel(subcmd?: string) {
  if (subcmd === "add") {
    await addChannel();
  } else if (subcmd === "remove") {
    await removeChannel();
  } else {
    console.log("Usage:");
    console.log("  jawclaw channel add      Add a channel");
    console.log("  jawclaw channel remove   Remove a channel");
  }
}

async function addChannel() {
  const config = await loadConfig();
  if (!config) {
    console.log("Run jawclaw first to set up.");
    return;
  }

  await initRegistry(config.extensions);

  const extensions = listChannels();
  const channelType = await p.select({
    message: "Channel type",
    options: extensions.map((e) => ({ value: e.name, label: e.label })),
  });

  if (p.isCancel(channelType)) return;

  const ext = getChannel(channelType as string)!;
  const answers: Record<string, string> = {};

  for (const field of ext.configFields) {
    const val = await p.text({
      message: field.label,
      placeholder: field.placeholder,
      validate: field.required ? (v) => (!v ? "Required" : undefined) : undefined,
    });
    if (p.isCancel(val)) return;
    answers[field.key] = val as string;
  }

  config.channels.push({ type: channelType as string, ...answers });
  await saveConfig(config);
  console.log(`✅ ${ext.label} channel added`);
}

async function removeChannel() {
  const config = await loadConfig();
  if (!config) {
    console.log("Run jawclaw first to set up.");
    return;
  }

  if (config.channels.length === 0) {
    console.log("No channels to remove.");
    return;
  }

  await initRegistry(config.extensions);

  const choice = await p.select({
    message: "Which channel to remove?",
    options: config.channels.map((c, i) => {
      const ext = getChannel(c.type);
      const name = ext ? ext.label : c.type;
      // Show a config hint to distinguish duplicates (e.g. "Telegram (123456:A...)")
      const hint = c.token ? ` (${c.token.slice(0, 10)}...)` : "";
      return { value: String(i), label: `${name}${hint}` };
    }),
  });

  if (p.isCancel(choice)) return;

  const idx = Number(choice);
  const removed = config.channels.splice(idx, 1)[0];
  await saveConfig(config);

  const ext = getChannel(removed.type);
  console.log(`✅ Removed ${ext ? ext.label : removed.type} channel`);
}
