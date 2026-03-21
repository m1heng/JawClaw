import * as p from "@clack/prompts";
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

  const result = await p.group(
    {
      type: () =>
        p.select({
          message: "Channel type",
          options: [
            { value: "telegram", label: "Telegram" },
          ],
        }),
      token: () =>
        p.text({
          message: "Bot Token",
          placeholder: "123456:ABC-DEF...",
          validate: (v) =>
            v?.includes(":") ? undefined : "Should contain ':'",
        }),
    },
    { onCancel: () => process.exit(0) },
  );

  config.channels.push({
    type: result.type as string,
    token: result.token as string,
  });

  await saveConfig(config);
  console.log(`✅ ${result.type} channel added`);
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

  const choice = await p.select({
    message: "Which channel to remove?",
    options: config.channels.map((c, i) => ({
      value: String(i),
      label: `${c.type} (${c.token.slice(0, 8)}...)`,
    })),
  });

  if (p.isCancel(choice)) return;

  const idx = Number(choice);
  const removed = config.channels.splice(idx, 1)[0];
  await saveConfig(config);
  console.log(`✅ Removed ${removed.type} channel`);
}
