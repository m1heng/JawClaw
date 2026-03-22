import {
  MouthAgent,
  CronScheduler,
  LocalShell,
  createOpenAIClient,
  createGeminiClient,
  createAnthropicClient,
} from "@jawclaw/core";
import type { LLMClient, HandServices } from "@jawclaw/core";
import { TelegramChannel, WeixinChannel, FeishuChannel } from "@jawclaw/channels";
import type { Channel } from "@jawclaw/channels";
import type { Config, ProviderConfig } from "./config.js";

function createLLM(provider: ProviderConfig): LLMClient {
  switch (provider.type) {
    case "openai":
      return createOpenAIClient(provider.apiKey, provider.baseUrl);
    case "gemini":
      return createGeminiClient(provider.apiKey);
    case "anthropic":
      return createAnthropicClient(provider.apiKey, provider.baseUrl);
    default:
      throw new Error(`Unknown provider type: ${provider.type}`);
  }
}

export async function startBot(config: Config) {
  const { provider, channels: channelConfigs } = config;

  if (!provider) {
    console.error("No LLM provider configured. Run: jawclaw provider add");
    process.exit(1);
  }

  const mouthLlm = createLLM(provider);
  const handLlm = createLLM(provider);

  // Validate LLM connectivity before starting channels
  try {
    await mouthLlm.createCompletion({
      model: provider.mouthModel,
      messages: [{ role: "user", content: "ping" }],
    });
    console.log("✅ LLM connected");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ LLM connection failed: ${msg}`);
    console.error("   Check your API key and model name in .jawclaw/config.json");
    process.exit(1);
  }

  const cron = new CronScheduler();
  const shell = new LocalShell();

  const sessionsDir = ".jawclaw/sessions";

  // Multi-channel router: "channel:chatId" → channel instance
  // Keyed by channel name + chatId to avoid cross-channel ID collisions.
  const channelRouter = new Map<string, Channel>();

  const routerKey = (channel: string, chatId: string) => `${channel}:${chatId}`;

  const sendMessage = async (compositeId: string, text: string) => {
    const ch = channelRouter.get(compositeId);
    if (ch) {
      // Extract original chatId (strip "channel:" prefix)
      const chatId = compositeId.substring(compositeId.indexOf(":") + 1);
      await ch.sendReply(chatId, text);
    } else {
      console.error(`[router] No channel for chatId ${compositeId}`);
    }
  };

  const handServices: HandServices = {
    sendMessage,
    cronSchedule: (description, cronExpr, chatId) =>
      cron.schedule(description, cronExpr, async (desc) => {
        await mouth.handleMessage(
          `[Scheduled task triggered] ${desc}`,
          { chatId, senderId: "system", senderName: "Cron", channel: "cron" },
        );
      }),
    cronList: () => cron.list(),
    cronDelete: (id) => cron.delete(id),
    memoryRoot: ".jawclaw/memory",
  };

  const mouth = new MouthAgent({
    sessionsDir,
    config: { model: provider.mouthModel, apiKey: provider.apiKey, baseUrl: provider.baseUrl },
    llm: mouthLlm,
    handConfig: { model: provider.handModel, apiKey: provider.apiKey, baseUrl: provider.baseUrl },
    handLlm: handLlm,
    handServices,
    sendMessage,
    shell,
  });

  // Start all configured channels
  const activeChannels: Channel[] = [];

  for (const cc of channelConfigs) {
    let ch: Channel | null = null;

    if (cc.type === "telegram") {
      ch = new TelegramChannel(cc.token);
    } else if (cc.type === "weixin") {
      ch = new WeixinChannel(cc.token);
    } else if (cc.type === "feishu") {
      ch = new FeishuChannel(cc.token, cc.appSecret!);
    }

    if (!ch) continue;

    const channel = ch;
    channel.onMessage(async (msg) => {
      const compositeId = routerKey(msg.channel, msg.chatId);
      channelRouter.set(compositeId, channel);
      await channel.sendTyping(msg.chatId);
      await mouth.handleMessage(msg.text, {
        chatId: compositeId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        channel: msg.channel,
      });
    });

    await channel.start();
    activeChannels.push(channel);
  }

  if (activeChannels.length === 0) {
    console.error("No channels configured. Run: jawclaw channel add");
    process.exit(1);
  }

  console.log(`🐾 JawClaw running — ${activeChannels.length} channel(s) active`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n🐾 Shutting down...");
    cron.destroy();
    for (const ch of activeChannels) {
      await ch.stop().catch(() => {});
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
