# Extension 系统设计 — Channel First (v3)

## 目标

允许外部 npm 包为 JawClaw 提供 Channel 实现，无需修改任何 core/cli 代码。
内置 channel 必须使用相同的契约，确保只有一条经过测试的代码路径（dogfooding）。

## 当前痛点

1. 新增一个 channel 需要改 4 个文件：`start.ts`、`onboard.ts`、`commands/channel.ts`、`channels/index.ts`
2. 所有 channel 类型都是硬编码的 switch/if-else
3. `ChannelConfig` 用了宽松的 `type: string`，但 CLI 只能处理已知值

## 历次 Review 修复记录

| # | 问题 | 修复 |
|---|------|------|
| v1-1 | Bootstrap 路径不完整 — `channel add` 看不到外部 extension | 共享 `initRegistry()` 供所有 CLI 入口调用 |
| v1-2 | `import(pkg)` 无限制代码执行 | 包名白名单 (`jawclaw-ext-*` / `@jawclaw/ext-*`) + shape 校验 + try/catch |
| v1-3 | ChannelConfig "不变" 是假的 | 新类型 `{ type: string; [key: string]: string }` + 保留字段校验 |
| v1-4 | Channel identity 三处重复 | ~~extension `name` 注入~~ → v3: registry 层统一包装，extension 不参与 |
| v1-5 | `core/dist/extension.*` 残留 | 已删除；extension 类型只在 `@jawclaw/channels` |
| v1-6 | 名字冲突 crash startup | warn + skip |
| v2-1 | 全局安装 CLI 无法 resolve 本地 extension 包 | `createRequire(process.cwd())` 从项目目录解析 |
| v2-2 | `channelName` 注入放在 extension `create()` 里，不可控 | registry 的 `createChannel()` 包装层统一注入 |
| v2-3 | startup 不校验 config 必填字段 | `createChannel()` 调用前校验 required fields |
| v2-4 | `initRegistry()` 单次执行，extensions 列表变化时不重新加载 | 去掉 `initialized` flag，built-ins 幂等注册，extensions 增量加载 |
| v2-5 | `validateExtension()` 不够深 | 校验每个 field 的 shape + key 唯一性 |

## 设计

### Extension 契约

```typescript
// packages/channels/src/extension.ts（放在 @jawclaw/channels，不是 core）

/** extension 不能使用的 config key */
const RESERVED_KEYS = new Set(["type"]);

export type ConfigField = {
  key: string;        // config.json 的 key，如 "token"
  label: string;      // CLI 提示文案，如 "Bot Token"
  placeholder?: string;
  required?: boolean;
};

export type ChannelExtension = {
  type: "channel";
  name: string;              // 唯一 ID："telegram", "discord"
  label: string;             // 显示名：「Telegram」「Discord」
  configFields: ConfigField[];
  create(config: Record<string, string>): Channel;
};

// 联合类型 — 未来扩展 provider/tool 时加入
export type Extension = ChannelExtension;
```

**为什么放在 `@jawclaw/channels`？**
`Channel` 接口在这个包里。把 `ChannelExtension` 放在旁边可以避免循环依赖
（core 不能 import channels）。

### Shape 校验

```typescript
// packages/channels/src/extension.ts

export function validateExtension(ext: unknown): ext is ChannelExtension {
  if (!ext || typeof ext !== "object") return false;
  const e = ext as Record<string, unknown>;
  if (e.type !== "channel") return false;
  if (typeof e.name !== "string" || !e.name) return false;
  if (typeof e.label !== "string") return false;
  if (!Array.isArray(e.configFields)) return false;
  if (typeof e.create !== "function") return false;

  // 深度校验 configFields
  const seenKeys = new Set<string>();
  for (const field of e.configFields as unknown[]) {
    if (!field || typeof field !== "object") return false;
    const f = field as Record<string, unknown>;
    if (typeof f.key !== "string" || !f.key) return false;
    if (typeof f.label !== "string") return false;
    if (RESERVED_KEYS.has(f.key)) {
      console.error(`Extension "${e.name}": configField key "${f.key}" 是保留字段`);
      return false;
    }
    if (seenKeys.has(f.key)) {
      console.error(`Extension "${e.name}": configField key "${f.key}" 重复`);
      return false;
    }
    seenKeys.add(f.key);
  }
  return true;
}
```

### Channel 接口变更 — 身份 SSOT

```typescript
// packages/channels/src/channel.ts
export interface Channel {
  readonly channelName: string;   // 新增 — 由 registry 统一注入，不由 class 自行设置
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
  sendReply(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}
```

内置 channel class 移除硬编码的 `channel: "telegram"` 字符串，
改为使用 `this.channelName`：

```typescript
// 改动前
channel: "telegram",

// 改动后
channel: this.channelName,
```

**关键**：`channelName` 不由 extension 的 `create()` 赋值，
而由 registry 层的 `createChannel()` 统一注入（见下文）。
extension 作者无需关心这个字段。

### 内置 Channel 描述符

每个现有 channel 在 class 旁边导出描述符：

```typescript
// packages/channels/src/telegram.ts
export const telegramExtension: ChannelExtension = {
  type: "channel",
  name: "telegram",
  label: "Telegram",
  configFields: [
    { key: "token", label: "Bot Token", placeholder: "123456:ABC-DEF...", required: true },
  ],
  create: (c) => new TelegramChannel(c.token),
  // 注意：create() 只负责构造实例，不管 channelName
};
```

```typescript
// packages/channels/src/weixin.ts
export const weixinExtension: ChannelExtension = {
  type: "channel",
  name: "weixin",
  label: "WeChat (微信)",
  configFields: [
    { key: "token", label: "Bot Token", placeholder: "iLink bot token", required: true },
  ],
  create: (c) => new WeixinChannel(c.token),
};
```

```typescript
// packages/channels/src/feishu.ts
export const feishuExtension: ChannelExtension = {
  type: "channel",
  name: "feishu",
  label: "Feishu (飞书)",
  configFields: [
    { key: "token", label: "App ID", placeholder: "cli_xxxx", required: true },
    { key: "appSecret", label: "App Secret", required: true },
  ],
  create: (c) => new FeishuChannel(c.token, c.appSecret),
};
```

### Extension Registry

```typescript
// packages/channels/src/registry.ts

import { createRequire } from "node:module";
import type { Channel } from "./channel.js";
import type { ChannelExtension, ConfigField } from "./extension.js";
import { validateExtension } from "./extension.js";
import { telegramExtension } from "./telegram.js";
import { weixinExtension } from "./weixin.js";
import { feishuExtension } from "./feishu.js";

const registry = new Map<string, ChannelExtension>();

// ---- 注册 ----

export function registerChannel(ext: ChannelExtension): boolean {
  if (registry.has(ext.name)) {
    console.warn(`Channel "${ext.name}" 已注册 — 跳过`);
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

/**
 * 从 config 创建 Channel 实例。
 * 1. 校验 required fields
 * 2. 调用 extension.create()
 * 3. 统一注入 channelName（extension 作者不用管）
 */
export function createChannel(
  ext: ChannelExtension,
  config: Record<string, string>,
): Channel {
  // 校验必填字段
  for (const field of ext.configFields) {
    if (field.required && !config[field.key]) {
      throw new Error(
        `Channel "${ext.name}": 缺少必填配置 "${field.key}"（${field.label}）`,
      );
    }
  }

  const ch = ext.create(config);

  // 统一注入 channelName — 这是 channel identity 的唯一来源
  (ch as { channelName: string }).channelName = ext.name;

  return ch;
}

// ---- 初始化（幂等）----

/** 注册内置 channels（重复调用安全） */
export function registerBuiltins(): void {
  registerChannel(telegramExtension);
  registerChannel(weixinExtension);
  registerChannel(feishuExtension);
}

// ---- 动态加载（安全）----

const ALLOWED_PKG_RE = /^(jawclaw-ext-[\w-]+|@jawclaw\/ext-[\w-]+)$/;
const loadedPackages = new Set<string>();

/**
 * 加载外部 extension 包。
 * - 包名必须匹配 jawclaw-ext-* 或 @jawclaw/ext-*
 * - 使用 createRequire(cwd) 从项目目录解析，兼容全局安装的 CLI
 * - 已加载的包不会重复加载（增量）
 */
export async function loadExternalChannels(
  packageNames: string[],
): Promise<void> {
  // 用 cwd 的 require 来解析，确保全局安装的 CLI 能找到项目本地的包
  const require = createRequire(process.cwd() + "/package.json");

  for (const pkg of packageNames) {
    // 跳过已加载的
    if (loadedPackages.has(pkg)) continue;

    // 校验包名格式
    if (!ALLOWED_PKG_RE.test(pkg)) {
      console.error(
        `跳过 extension "${pkg}": 包名必须匹配 jawclaw-ext-* 或 @jawclaw/ext-*`,
      );
      continue;
    }

    try {
      // resolve 得到绝对路径，再 import()
      const resolved = require.resolve(pkg);
      const mod = await import(resolved);

      const candidates: unknown[] = Array.isArray(mod.default)
        ? mod.default
        : [mod.default];

      for (const candidate of candidates) {
        if (validateExtension(candidate)) {
          registerChannel(candidate);
        } else {
          console.error(`跳过 "${pkg}" 中的无效 extension 导出`);
        }
      }

      loadedPackages.add(pkg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`加载 extension "${pkg}" 失败: ${msg}`);
    }
  }
}

// ---- 一键初始化（所有 CLI 入口调用）----

/**
 * 初始化 registry：注册内置 + 加载外部。
 * 幂等：多次调用安全，extensions 列表变化时增量加载。
 */
export async function initRegistry(
  extensionPackages?: string[],
): Promise<void> {
  registerBuiltins();
  if (extensionPackages?.length) {
    await loadExternalChannels(extensionPackages);
  }
}
```

### Config 类型变更

```typescript
// packages/cli/src/config.ts

export type ChannelConfig = {
  type: string;
  [key: string]: string;   // extension 定义的字段（token, appSecret, guildId 等）
};

export type Config = {
  provider?: ProviderConfig;
  channels: ChannelConfig[];
  extensions?: string[];         // 外部 extension npm 包名（仅 jawclaw-ext-* 格式）
};
```

**向后兼容**：现有 `{ type, token, appSecret? }` 的 config 完全匹配新类型。
CLI 的 `removeChannel` 显示改用 extension label + type，不再直接读 `c.token`。

### 启动流程 (start.ts)

```typescript
import { initRegistry, getChannel, createChannel } from "@jawclaw/channels";

export async function startBot(config: Config) {
  // 初始化 registry — 内置 + 外部
  await initRegistry(config.extensions);

  // 从 config 实例化 channels — 不再有 switch/if-else
  for (const cc of config.channels) {
    const ext = getChannel(cc.type);
    if (!ext) {
      console.error(`未知 channel 类型: "${cc.type}" — 是否已安装对应的 extension？`);
      continue;
    }

    let ch: Channel;
    try {
      ch = createChannel(ext, cc);  // 校验 + 创建 + 注入 channelName
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      continue;
    }

    // ... wire onMessage, start 等（与现有代码相同）
  }
}
```

### CLI 入口 — 共享初始化

每个需要 registry 的 CLI 路径都先调 `initRegistry()`：

```typescript
// commands/channel.ts — addChannel()
import { initRegistry, listChannels, getChannel } from "@jawclaw/channels";

async function addChannel() {
  const config = await loadConfig();
  if (!config) { /* ... */ return; }

  // 初始化 registry，外部 extension 也会出现在菜单里
  await initRegistry(config.extensions);

  const extensions = listChannels();
  const channelType = await p.select({
    message: "Channel type",
    options: extensions.map((e) => ({ value: e.name, label: e.label })),
  });
  if (p.isCancel(channelType)) return;

  const ext = getChannel(channelType as string)!;
  const answers: Record<string, string> = {};
  for (const field of ext.configFields) {
    const val = await p.text({
      message: field.label,
      placeholder: field.placeholder,
      validate: field.required ? (v) => (!v ? "Required" : undefined) : undefined,
    });
    if (p.isCancel(val)) return;
    answers[field.key] = val as string;
  }

  config.channels.push({ type: channelType as string, ...answers });
  await saveConfig(config);
  console.log(`✅ ${ext.label} channel added`);
}
```

```typescript
// onboard.ts — channel 部分
// 首次运行时 config.extensions 不存在，只有内置 channel
await initRegistry();
const extensions = listChannels();
const channelType = await p.select({
  message: "Channel type",
  options: extensions.map((e) => ({ value: e.name, label: e.label })),
});
// ... 后续用 configFields 驱动表单
```

说明：首次 onboard 时 `config.extensions` 尚不存在，所以只显示内置 channel。
外部 channel 需要用户先安装包、编辑 config，然后 `channel add`。这是符合预期的 —
首次设置应该简单。

### 外部 Extension 包规范

```typescript
// jawclaw-ext-discord/src/index.ts
import type { ChannelExtension } from "@jawclaw/channels";
import { DiscordChannel } from "./discord-channel.js";

const extension: ChannelExtension = {
  type: "channel",
  name: "discord",
  label: "Discord",
  configFields: [
    { key: "token", label: "Bot Token", required: true },
    { key: "guildId", label: "Server ID", placeholder: "12345", required: true },
  ],
  // 只需要构造实例，channelName 由 registry 自动注入
  create: (c) => new DiscordChannel(c.token, c.guildId),
};

export default extension;
```

**包名规范**：必须匹配 `jawclaw-ext-*` 或 `@jawclaw/ext-*`（加载时强制校验）。
**导出**：default export `ChannelExtension` 或 `ChannelExtension[]`。
**Peer dep**：`@jawclaw/channels` 获取 `Channel` 接口和 extension 类型。

### 用户流程

```
1. pnpm add jawclaw-ext-discord             # 安装
2. 编辑 .jawclaw/config.json:               # 注册
     "extensions": ["jawclaw-ext-discord"]
3. jawclaw channel add                      # Discord 出现在列表中
     → 按 configFields 提示输入 Bot Token、Server ID
4. jawclaw start                            # 加载并启动
```

## 文件变更

| 文件 | 变更 |
|------|------|
| `channels/src/extension.ts` | **新增** — 类型定义 + `validateExtension()` |
| `channels/src/registry.ts` | **新增** — registry + `createChannel()` + 安全加载器 |
| `channels/src/channel.ts` | `Channel` 接口加 `channelName` 属性 |
| `channels/src/telegram.ts` | 导出描述符；消息中用 `this.channelName` |
| `channels/src/weixin.ts` | 同上 |
| `channels/src/feishu.ts` | 同上 |
| `channels/src/index.ts` | 重新导出类型 + 描述符 + registry API |
| `cli/src/config.ts` | `ChannelConfig` → index signature；加 `extensions?` |
| `cli/src/start.ts` | switch 替换为 `initRegistry()` + `createChannel()` |
| `cli/src/commands/channel.ts` | 动态选项来自 `listChannels()` |
| `cli/src/onboard.ts` | 同上 |
| `core/dist/extension.*` | **删除** — 原型阶段的残留产物 |

**不变**：channel class 内部逻辑（除 `channelName` 外）、core 包源码。

## 安全模型

- **包名白名单**：只加载 `jawclaw-ext-*` / `@jawclaw/ext-*`，限制攻击面到用户显式安装的包
- **项目目录解析**：`createRequire(cwd)` 确保全局安装的 CLI 能正确 resolve 项目本地的 extension
- **Shape 校验**：`validateExtension()` 检查每个导出的完整结构，包括 configFields 的深度校验（类型、唯一性、保留字段）。不合格的直接跳过并告警
- **Config 必填校验**：`createChannel()` 在调用 `create()` 前验证所有 required 字段都存在
- **保留字段保护**：configFields 不能使用 `type` 等保留 key
- **冲突处理**：重名 warn + skip（先注册的赢），不会 crash startup
- **信任边界**：`.jawclaw/config.json` 是用户本地文件，信任等级与 `package.json` scripts 相同

## 未来泛化

同样的模式可以用于 `ProviderExtension`（LLM 后端）和 `ToolExtension`（Hand 工具）。
`Extension = ChannelExtension | ProviderExtension | ...` 联合类型自然扩展。
`initRegistry()` 扩展为加载所有 extension 类型。

现在不做 — 等有真实需求再说。
