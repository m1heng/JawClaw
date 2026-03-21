import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG_PATH = ".jawclaw/config.json";

export type ProviderConfig = {
  type: string; // "openai" for now
  apiKey: string;
  baseUrl?: string;
  mouthModel: string;
  handModel: string;
};

export type ChannelConfig = {
  type: string; // "telegram" for now
  token: string;
};

export type Config = {
  provider: ProviderConfig;
  channels: ChannelConfig[];
};

export async function loadConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
