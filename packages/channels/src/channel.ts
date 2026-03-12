export type ChannelMessage = {
  chatId: string;
  text: string;
  senderId: string;
  senderName?: string;
};

export interface Channel {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
  sendReply(chatId: string, text: string): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}
