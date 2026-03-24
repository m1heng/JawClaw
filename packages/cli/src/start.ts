import {
  MouthAgent,
  HAND_SYSTEM_PROMPT,
  CronScheduler,
  LocalShell,
  createOpenAIClient,
  createGeminiClient,
  createAnthropicClient,
  HAND_TOOLS,
  BuiltinExecutor,
  CLIExecutor,
  CLI_PRESETS,
  LocalRuntime,
  FileTaskStore,
  FileCheckpointStore,
} from "@jawclaw/core";
import type { LLMClient, HandServices, HandExecutor } from "@jawclaw/core";
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
  const memoryRoot = ".jawclaw/memory";

  // Multi-channel router: "channel:chatId" → channel instance (populated lazily on first message)
  const channelRouter = new Map<string, Channel>();
  // Fallback: "channelType" → channel instance (populated at boot, for crash recovery)
  const channelByType = new Map<string, Channel>();
  const routerKey = (channel: string, chatId: string) => `${channel}:${chatId}`;

  const sendMessage = async (compositeId: string, text: string) => {
    const colonIdx = compositeId.indexOf(":");
    let ch = channelRouter.get(compositeId);
    // Fallback: route by channel type prefix (for crash recovery before any inbound message)
    if (!ch && colonIdx > 0) {
      ch = channelByType.get(compositeId.substring(0, colonIdx));
    }
    if (ch) {
      const chatId = compositeId.substring(colonIdx + 1);
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
    memoryRoot,
  };

  // Build runtime: TaskStore → Executor → Runtime
  const taskStore = new FileTaskStore(".jawclaw/tasks", shell);
  const checkpointStore = new FileCheckpointStore(".jawclaw/checkpoints", shell);

  const handRuntimeConfig = config.hand ?? { type: "builtin" };
  let executor: HandExecutor;

  if (handRuntimeConfig.type === "cli") {
    const presetName = handRuntimeConfig.preset ?? "";
    const preset = CLI_PRESETS[presetName];
    if (!preset && !handRuntimeConfig.command) {
      console.error(`❌ Unknown CLI preset "${presetName}" and no custom command set.`);
      process.exit(1);
    }
    executor = new CLIExecutor({
      name: presetName || "custom-cli",
      command: handRuntimeConfig.command ?? preset?.command ?? "",
      buildArgs: preset?.buildArgs ?? ((task) => [`'${task.description.replace(/'/g, "'\\''")}'`]),
      parseOutput: preset?.parseOutput ?? ((stdout, code) => ({
        status: code === 0 ? "completed" as const : "failed" as const,
        summary: stdout.slice(-2000),
        error: code !== 0 ? `exit ${code}` : undefined,
      })),
      timeout: handRuntimeConfig.timeout,
      env: handRuntimeConfig.env,
    });
  } else {
    executor = new BuiltinExecutor({
      llm: handLlm,
      config: {
        model: provider.handModel,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        systemPrompt: HAND_SYSTEM_PROMPT,
        tools: HAND_TOOLS,
      },
      services: handServices,
      checkpointStore,
    });
  }

  const runtime = new LocalRuntime(taskStore, executor, { shell, sessionsDir }, checkpointStore);

  const mouth = new MouthAgent({
    sessionsDir,
    config: { model: provider.mouthModel, apiKey: provider.apiKey, baseUrl: provider.baseUrl },
    llm: mouthLlm,
    runtime,
    sendMessage,
    shell,
    memoryRoot,
  });

  // Start all configured channels (before runtime.start() so channelRouter
  // is populated before crash recovery replays completed-but-undelivered results)
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
    channelByType.set(cc.type, channel); // for crash recovery routing
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

  // Start runtime AFTER channels so channelRouter is populated for crash recovery
  await runtime.start();

  console.log(`🐾 JawClaw running — ${activeChannels.length} channel(s) active`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n🐾 Shutting down...");
    await runtime.stop();
    cron.destroy();
    for (const ch of activeChannels) {
      await ch.stop().catch(() => {});
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
