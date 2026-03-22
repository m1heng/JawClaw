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

  const channelType = await p.select({
    message: "Channel type",
    options: [
      { value: "telegram", label: "Telegram" },
      { value: "weixin", label: "WeChat (微信)" },
      { value: "feishu", label: "Feishu (飞书)" },
    ],
  });

  if (p.isCancel(channelType)) return;

  if (channelType === "feishu") {
    const creds = await p.group(
      {
        appId: () =>
          p.text({
            message: "App ID",
            placeholder: "cli_xxxx",
            validate: (v) => (!v ? "Required" : undefined),
          }),
        appSecret: () =>
          p.text({
            message: "App Secret",
            placeholder: "xxxx",
            validate: (v) => (!v ? "Required" : undefined),
          }),
      },
      { onCancel: () => process.exit(0) },
    );

    config.channels.push({
      type: "feishu",
      token: creds.appId as string,
      appSecret: creds.appSecret as string,
    });
  } else {
    const placeholder =
      channelType === "telegram" ? "123456:ABC-DEF..." : "iLink bot token";

    const token = await p.text({
      message: "Bot Token",
      placeholder,
      validate: (v) => (!v ? "Required" : undefined),
    });

    if (p.isCancel(token)) return;

    config.channels.push({
      type: channelType as string,
      token: token as string,
    });
  }

  await saveConfig(config);
  console.log(`✅ ${channelType} channel added`);
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
