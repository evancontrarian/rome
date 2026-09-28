import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordApiFixture, DISCORD_DM, DISCORD_TOKEN, DISCORD_USER } from "./discord.js";
import { TelegramApiFixture, TELEGRAM_TOKEN } from "./telegram.js";
import { LarkApiFixture, LARK_CHAT } from "./lark.js";
import { WechatApiFixture, WECHAT_USER } from "./wechat.js";
import type { ImFixtureServer } from "./server.js";

export interface PlaygroundMessage {
  id: string;
  text: string;
  edited: boolean;
}

export interface PlaygroundPeer {
  server: ImFixtureServer;
  send(text: string): Promise<string>;
  edit?: (id: string, text: string) => Promise<unknown>;
  inbound(text: string): Promise<void>;
  messages(): PlaygroundMessage[];
  mutation(id?: string): { method: string; path: string };
  close(): Promise<void>;
}

export async function createPlaygroundPeer(
  platform: "discord" | "telegram" | "feishu" | "wechat",
  receive: (text: string) => void,
): Promise<PlaygroundPeer> {
  const fixture = await (platform === "discord"
    ? new DiscordApiFixture()
    : platform === "telegram"
      ? new TelegramApiFixture()
      : platform === "feishu"
        ? new LarkApiFixture()
        : new WechatApiFixture()
  ).start();
  const directory =
    fixture instanceof WechatApiFixture
      ? await mkdtempDisposable(join(tmpdir(), "rome-im-playground-"))
      : undefined;
  const adapter =
    fixture instanceof WechatApiFixture
      ? fixture.createAdapter(directory!.path)
      : fixture.createAdapter();
  let delivered: (() => void) | undefined;
  adapter.onMessage(async (message) => {
    receive(message.text);
    delivered?.();
  });
  const close = async () => {
    try {
      await adapter.stop();
    } finally {
      try {
        await fixture.close();
      } finally {
        await directory?.[Symbol.asyncDispose]();
      }
    }
  };
  try {
    await adapter.start();
    if (fixture instanceof DiscordApiFixture && "directConversationFor" in adapter)
      await adapter.directConversationFor(DISCORD_USER);
    if (fixture instanceof TelegramApiFixture || fixture instanceof WechatApiFixture)
      await fixture.untilPolling();
    if (fixture instanceof LarkApiFixture) await fixture.untilConnected();
  } catch (error) {
    await close();
    throw error;
  }
  const common = {
    server: fixture.server,
    close,
    inbound: async (text: string) => {
      let timer: ReturnType<typeof setTimeout>;
      const received = new Promise<void>((resolve, reject) => {
        delivered = resolve;
        timer = setTimeout(
          () => reject(new Error("Inbound message was not received by the adapter")),
          5000,
        );
      });
      // Attach the rejection handler before injecting a gateway event.
      const emit = Promise.resolve().then(() => fixture.emitMessage(text));
      try {
        await Promise.all([received, emit]);
      } finally {
        clearTimeout(timer!);
        delivered = undefined;
      }
    },
  };
  if (fixture instanceof DiscordApiFixture) {
    const rest = fixture.transport().createRest!({ version: "10", retries: 0 }).setToken(
      DISCORD_TOKEN,
    );
    const path = `/channels/${DISCORD_DM}/messages`;
    return {
      ...common,
      send: async (text) =>
        ((await rest.post(path, { body: { content: text } })) as { id: string }).id,
      edit: (id, text) => rest.patch(`${path}/${id}`, { body: { content: text } }),
      mutation: (id) => ({
        method: id ? "PATCH" : "POST",
        path: `/api/v10${path}${id ? `/${id}` : ""}`,
      }),
      messages: () =>
        [...fixture.messages.values()]
          .filter((m) => m.author.bot)
          .map((m) => ({ id: m.id, text: m.content, edited: !!m.edited_timestamp })),
    };
  }
  if (fixture instanceof TelegramApiFixture) {
    const api = fixture.createBot(TELEGRAM_TOKEN).api;
    return {
      ...common,
      send: async (text) => String((await api.sendMessage(123, text)).message_id),
      edit: (id, text) => api.editMessageText(123, Number(id), text),
      mutation: (id) => ({
        method: "POST",
        path: `/bot${TELEGRAM_TOKEN}/${id ? "editMessageText" : "sendMessage"}`,
      }),
      messages: () =>
        [...fixture.messages.values()].map((m) => ({
          id: String(m.message_id),
          text: String(m.text ?? ""),
          edited: !!m.edit_date,
        })),
    };
  }
  if (fixture instanceof LarkApiFixture) {
    const channel = fixture.createChannel();
    return {
      ...common,
      send: async (text) => (await channel.send(LARK_CHAT, { text })).messageId,
      edit: async (id, text) => {
        const result = await channel.rawClient.im.message.update({
          path: { message_id: id },
          data: { msg_type: "text", content: JSON.stringify({ text }) },
        });
        if (result.code !== 0) throw new Error(`Lark error ${result.code}: ${result.msg}`);
        return result;
      },
      mutation: (id) => ({
        method: id ? "PUT" : "POST",
        path: `/open-apis/im/v1/messages${id ? `/${id}` : ""}`,
      }),
      messages: () =>
        [...fixture.messages.values()]
          .filter((m) => m.sender?.sender_type === "app")
          .map((m) => ({
            id: m.message_id,
            text: JSON.parse(m.body.content).text ?? m.body.content,
            edited: m.updated,
          })),
    };
  }
  return {
    ...common,
    send: async (text) => {
      await adapter.sendMessage(WECHAT_USER, WECHAT_USER, { text });
      return String(fixture.messages.length);
    },
    mutation: () => ({ method: "POST", path: "/ilink/bot/sendmessage" }),
    messages: () =>
      fixture.messages.map((m, i) => ({
        id: String(i + 1),
        text: (m.item_list as { text_item?: { text: string } }[])
          .map((item) => item.text_item?.text ?? "")
          .join(""),
        edited: false,
      })),
  };
}
