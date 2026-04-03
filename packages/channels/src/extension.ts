import type { Channel } from "./channel.js";

/** Extension 不能使用的 config key */
const RESERVED_KEYS = new Set(["type"]);

/** CLI 提示用户输入的单个配置字段 */
export type ConfigField = {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
};

/** Channel extension 描述符 — 内置和外部共用同一契约 */
export type ChannelExtension = {
  type: "channel";
  name: string;
  label: string;
  configFields: ConfigField[];
  create(config: Record<string, string>): Channel;
};

export type Extension = ChannelExtension;

/** 深度校验 extension 导出是否合法 */
export function validateExtension(ext: unknown): ext is ChannelExtension {
  if (!ext || typeof ext !== "object") return false;
  const e = ext as Record<string, unknown>;
  if (e.type !== "channel") return false;
  if (typeof e.name !== "string" || !e.name) return false;
  if (typeof e.label !== "string") return false;
  if (!Array.isArray(e.configFields)) return false;
  if (typeof e.create !== "function") return false;

  const seenKeys = new Set<string>();
  for (const field of e.configFields as unknown[]) {
    if (!field || typeof field !== "object") return false;
    const f = field as Record<string, unknown>;
    if (typeof f.key !== "string" || !f.key) return false;
    if (typeof f.label !== "string") return false;
    if (RESERVED_KEYS.has(f.key)) {
      console.error(`Extension "${e.name}": configField key "${f.key}" is reserved`);
      return false;
    }
    if (seenKeys.has(f.key)) {
      console.error(`Extension "${e.name}": duplicate configField key "${f.key}"`);
      return false;
    }
    seenKeys.add(f.key);
  }
  return true;
}
