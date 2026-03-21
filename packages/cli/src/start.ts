import { MouthAgent, CronScheduler, LocalShell } from "@jawclaw/core";
import { createOpenAIClient } from "@jawclaw/core";
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

  const mouthLlm = createOpenAIClient(apiKey, baseUrl);
  const handLlm = createOpenAIClient(apiKey, baseUrl);
  const channel = new TelegramChannel(token);
  const cron = new CronScheduler();
  const shell = new LocalShell();

  const sessionsDir = ".jawclaw/sessions";

  const handServices: HandServices = {
    sendMessage: (chatId, text) => channel.sendReply(chatId, text),
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
    config: { model: mouthModel, apiKey, baseUrl },
    llm: mouthLlm,
    handConfig: { model: handModel, apiKey, baseUrl },
    handLlm: handLlm,
    handServices,
    sendMessage: (chatId, text) => channel.sendReply(chatId, text),
    shell,
  });

  channel.onMessage(async (msg) => {
    await channel.sendTyping(msg.chatId);
    await mouth.handleMessage(msg.text, {
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      channel: msg.channel,
    });
  });

  await channel.start();
}
