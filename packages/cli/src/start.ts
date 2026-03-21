import {
  MouthAgent,
  CronScheduler,
  LocalShell,
  createOpenAIClient,
  createGeminiClient,
  createAnthropicClient,
} from "@jawclaw/core";
import type { LLMClient, HandServices } from "@jawclaw/core";
import { TelegramChannel } from "@jawclaw/channels";
import type { Channel } from "@jawclaw/channels";
import type { Config, ProviderConfig } from "./config.js";

function createLLM(provider: ProviderConfig): LLMClient {
  switch (provider.type) {
    case "openai":
      return createOpenAIClient(provider.apiKey, provider.baseUrl);
    case "gemini":
      return createGeminiClient(provider.apiKey);
    case "anthropic":
      return createAnthropicClient(provider.apiKey);
    default:
      throw new Error(`Unknown provider type: ${provider.type}`);
  }
}

export async function startBot(config: Config) {
  const { provider, channels: channelConfigs } = config;

  const mouthLlm = createLLM(provider);
  const handLlm = createLLM(provider);
  const cron = new CronScheduler();
  const shell = new LocalShell();

  const sessionsDir = ".jawclaw/sessions";

  // Multi-channel router: chatId → channel instance
  const channelRouter = new Map<string, Channel>();

  const sendMessage = async (chatId: string, text: string) => {
    const ch = channelRouter.get(chatId);
    if (ch) {
      await ch.sendReply(chatId, text);
    } else {
      console.error(`[router] No channel for chatId ${chatId}`);
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
    if (cc.type === "telegram") {
      const tg = new TelegramChannel(cc.token);

      tg.onMessage(async (msg) => {
        channelRouter.set(msg.chatId, tg);
        await tg.sendTyping(msg.chatId);
        await mouth.handleMessage(msg.text, {
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          channel: msg.channel,
        });
      });

      await tg.start();
      activeChannels.push(tg);
    }
  }

  if (activeChannels.length === 0) {
    console.error("No channels configured. Run: jawclaw channel add");
    process.exit(1);
  }

  console.log(`🐾 JawClaw running — ${activeChannels.length} channel(s) active`);
}
