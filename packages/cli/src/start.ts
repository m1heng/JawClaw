import { MouthAgent, createLLMClient, CronScheduler } from "@jawclaw/core";
import { TelegramChannel } from "@jawclaw/channels";
import type { HandServices } from "@jawclaw/core";

export async function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const mouthModel = process.env.MOUTH_MODEL ?? "gpt-4o-mini";
  const handModel = process.env.HAND_MODEL ?? "gpt-4o";

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const mouthLlm = createLLMClient(apiKey, baseUrl);
  const handLlm = createLLMClient(apiKey, baseUrl);
  const channel = new TelegramChannel(token);
  const cron = new CronScheduler();

  const sessionsDir = ".jawclaw/sessions";
  const mouths = new Map<string, MouthAgent>();

  // Build shared HandServices — channel and cron are shared across all agents
  const handServices: HandServices = {
    sendMessage: (chatId, text) => channel.sendReply(chatId, text),
    cronSchedule: (description, cronExpr) =>
      cron.schedule(description, cronExpr, (desc) => {
        console.log(`[cron] Triggered: ${desc}`);
      }),
    cronList: () => cron.list(),
    cronDelete: (id) => cron.delete(id),
    memoryRoot: ".jawclaw/memory",
    // webSearch: left undefined — configure via WEB_SEARCH_PROVIDER
  };

  channel.onMessage(async (msg) => {
    let mouth = mouths.get(msg.chatId);
    if (!mouth) {
      mouth = new MouthAgent({
        chatId: msg.chatId,
        sessionsDir,
        config: { model: mouthModel, apiKey, baseUrl },
        llm: mouthLlm,
        handConfig: { model: handModel, apiKey, baseUrl },
        handLlm: handLlm,
        handServices,
      });
      mouths.set(msg.chatId, mouth);
    }

    await channel.sendTyping(msg.chatId);

    await mouth.handleMessage(msg.text, async (reply) => {
      await channel.sendReply(msg.chatId, reply);
    });
  });

  await channel.start();
}
