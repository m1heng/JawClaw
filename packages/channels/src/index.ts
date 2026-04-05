export type { Channel, ChannelMessage } from "./channel.js";
export { chunkText } from "./channel.js";
export type { ChannelExtension, ConfigField, Extension } from "./extension.js";
export { validateExtension } from "./extension.js";
export {
  registerChannel,
  getChannel,
  listChannels,
  createChannel,
  registerBuiltins,
  loadExternalChannels,
  initRegistry,
} from "./registry.js";
export { TelegramChannel, telegramExtension } from "./telegram.js";
export { WeixinChannel, weixinExtension } from "./weixin.js";
export { FeishuChannel, feishuExtension } from "./feishu.js";
