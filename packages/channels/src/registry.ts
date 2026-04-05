import { createRequire } from "node:module";
import type { Channel } from "./channel.js";
import type { ChannelExtension } from "./extension.js";
import { validateExtension } from "./extension.js";
import { telegramExtension } from "./telegram.js";
import { weixinExtension } from "./weixin.js";
import { feishuExtension } from "./feishu.js";

const registry = new Map<string, ChannelExtension>();

// ---- 注册 ----

export function registerChannel(ext: ChannelExtension): boolean {
  if (registry.has(ext.name)) {
    console.warn(`Channel "${ext.name}" already registered — skipping`);
    return false;
  }
  registry.set(ext.name, ext);
  return true;
}

// ---- 查询 ----

export function getChannel(name: string): ChannelExtension | undefined {
  return registry.get(name);
}

export function listChannels(): ChannelExtension[] {
  return [...registry.values()];
}

// ---- 创建实例（SSOT 包装层）----

export function createChannel(
  ext: ChannelExtension,
  config: Record<string, string>,
): Channel {
  for (const field of ext.configFields) {
    if (field.required && !config[field.key]) {
      throw new Error(
        `Channel "${ext.name}": missing required config "${field.key}" (${field.label})`,
      );
    }
  }

  const ch = ext.create(config);
  ch.channelName = ext.name;
  return ch;
}

// ---- 内置注册 ----

export function registerBuiltins(): void {
  registerChannel(telegramExtension);
  registerChannel(weixinExtension);
  registerChannel(feishuExtension);
}

// ---- 动态加载 ----

const ALLOWED_PKG_RE = /^(jawclaw-ext-[\w-]+|@jawclaw\/ext-[\w-]+)$/;
const loadedPackages = new Set<string>();

export async function loadExternalChannels(
  packageNames: string[],
): Promise<void> {
  const req = createRequire(process.cwd() + "/package.json");

  for (const pkg of packageNames) {
    if (loadedPackages.has(pkg)) continue;

    if (!ALLOWED_PKG_RE.test(pkg)) {
      console.error(
        `Skipping extension "${pkg}": name must match jawclaw-ext-* or @jawclaw/ext-*`,
      );
      continue;
    }

    try {
      const resolved = req.resolve(pkg);
      const mod = await import(resolved);
      const candidates: unknown[] = Array.isArray(mod.default)
        ? mod.default
        : [mod.default];

      for (const candidate of candidates) {
        if (validateExtension(candidate)) {
          registerChannel(candidate);
        } else {
          console.error(`Skipping invalid extension export from "${pkg}"`);
        }
      }

      loadedPackages.add(pkg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load extension "${pkg}": ${msg}`);
    }
  }
}

// ---- 一键初始化 ----

export async function initRegistry(
  extensionPackages?: string[],
): Promise<void> {
  registerBuiltins();
  if (extensionPackages?.length) {
    await loadExternalChannels(extensionPackages);
  }
}
