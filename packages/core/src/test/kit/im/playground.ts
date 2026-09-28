import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createLogger } from "../../../logger.js";
import { createPlaygroundPeer, type PlaygroundPeer } from "./playground-peer.js";

export const playgroundConfig = z
  .object({
    platform: z.enum(["discord", "telegram", "feishu", "wechat"]),
    mode: z.enum(["edit", "append"]),
    chunkSize: z.number().int().min(2).max(4096),
    step: z.number().int().min(1).max(512),
    intervalMs: z.number().int().min(0).max(2000),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.platform === "wechat" && config.mode === "edit")
      context.addIssue({ code: "custom", message: "WeChat is append-only", path: ["mode"] });
    const limit =
      config.platform === "discord" ? 2000 : config.platform === "telegram" ? 4096 : 1000;
    if (config.chunkSize > limit)
      context.addIssue({
        code: "custom",
        message: `This preset supports a chunk size up to ${limit}`,
        path: ["chunkSize"],
      });
  });
const commandSchema = z
  .object({
    action: z.enum(["send", "stream", "inbound", "edit"]),
    text: z.string().min(1).max(10000),
    id: z.string().max(100).optional(),
    fault: z.enum(["none", "reject", "drop", "rate-limit"]).default("none"),
  })
  .strict();
export const playgroundPresets = {
  discord: { platform: "discord", mode: "edit", chunkSize: 2000, step: 12, intervalMs: 150 },
  telegram: { platform: "telegram", mode: "edit", chunkSize: 4096, step: 12, intervalMs: 150 },
  feishu: { platform: "feishu", mode: "edit", chunkSize: 1000, step: 12, intervalMs: 150 },
  wechat: { platform: "wechat", mode: "append", chunkSize: 1000, step: 12, intervalMs: 150 },
} as const;

/** Demo chunking measures UTF-16 units without cutting a Unicode code point. */
export function playgroundChunks(text: string, limit: number) {
  const chunks: string[] = [];
  let chunk = "";
  for (const point of text) {
    if (chunk && chunk.length + point.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += point;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function startPlayground(port = 0) {
  let config = playgroundConfig.parse(playgroundPresets.telegram);
  let peer: PlaygroundPeer | undefined;
  let busy = false;
  let error = "";
  let cancelled = false;
  let task: Promise<void> = Promise.resolve();
  let sequence = 0;
  const order = new Map<string, number>();
  const incoming: {
    id: string;
    text: string;
    edited: boolean;
    direction: string;
    order: number;
  }[] = [];
  const receive = (text: string) =>
    incoming.push({
      id: `in-${++sequence}`,
      text,
      edited: false,
      direction: "in",
      order: sequence,
    });
  const snapshot = () => ({
    config,
    presets: playgroundPresets,
    busy,
    error,
    messages: [
      ...incoming,
      ...(peer?.messages() ?? []).map((m) => {
        if (!order.has(m.id)) order.set(m.id, ++sequence);
        return { ...m, direction: "out", order: order.get(m.id)! };
      }),
    ].sort((a, b) => a.order - b.order),
    calls: peer?.server.calls.slice(-200) ?? [],
    errors: peer?.server.errors ?? [],
  });
  const open = async (next: typeof config) => {
    await peer?.close();
    peer = undefined;
    incoming.length = 0;
    order.clear();
    sequence = 0;
    config = next;
    peer = await createPlaygroundPeer(config.platform, receive);
  };
  await open(config);
  const run = async (command: z.infer<typeof commandSchema>) => {
    const current = peer!;
    if (command.action === "inbound") {
      await current.inbound(command.text);
      return;
    }
    if (command.action === "edit" && (!command.id || !current.edit || config.mode !== "edit"))
      throw new Error("Select an editable message first");
    if (command.action === "edit" && command.text.length > config.chunkSize)
      throw new Error("An edit must fit in one chunk");
    let fault = command.fault;
    const write = async (text: string, id?: string) => {
      if (current.server.calls.length >= 1000)
        throw new Error("Reset the session after 1,000 requests");
      if (fault !== "none") {
        current.server.once({
          ...current.mutation(id),
          ...(fault === "drop"
            ? { dropAfterAccept: true }
            : {
                response:
                  fault === "rate-limit"
                    ? {
                        status: 429,
                        headers: { "retry-after": "1" },
                        body: {
                          message: "Rate limited",
                          retry_after: 1,
                          global: false,
                          ok: false,
                          error_code: 429,
                          description: "Too Many Requests",
                          parameters: { retry_after: 1 },
                          code: 99991400,
                          msg: "Rate limited",
                          ret: -1,
                          errmsg: "Rate limited",
                        },
                      }
                    : {
                        status: 403,
                        body: {
                          message: "Forbidden",
                          ok: false,
                          error_code: 403,
                          description: "Forbidden",
                          code: 99991672,
                          msg: "Forbidden",
                          ret: -1,
                          errmsg: "Forbidden",
                        },
                      },
              }),
        });
        fault = "none";
      }
      const result = id ? (await current.edit!(id, text), id) : await current.send(text);
      snapshot();
      return result;
    };
    if (command.action === "edit") {
      await write(command.text, command.id);
      return;
    }
    for (const chunk of playgroundChunks(command.text, config.chunkSize)) {
      if (cancelled) break;
      if (command.action === "send" || config.mode === "append") {
        await write(chunk);
        if (command.action === "stream") await delay(config.intervalMs);
        continue;
      }
      let id: string | undefined;
      let text = "";
      const points = Array.from(chunk);
      for (let offset = 0; offset < points.length && !cancelled; offset += config.step) {
        text += points.slice(offset, offset + config.step).join("");
        id = await write(text, id);
        await delay(config.intervalMs);
      }
    }
  };
  const html = await readFile(new URL("./playground.html", import.meta.url));
  let origin = "";
  const server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return json(403, { error: "Use the local playground origin" });
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(html);
        return;
      }
      if (req.method === "GET" && req.url === "/state") return json(200, snapshot());
      if (req.method !== "POST" || !["/config", "/run", "/stop"].includes(req.url ?? ""))
        return json(404, { error: "Not found" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(415, { error: "Expected JSON" });
      if (req.url === "/stop") {
        cancelled = true;
        return json(200, { ok: true });
      }
      if (busy) return json(409, { error: "Wait for the current operation or stop it" });
      busy = true;
      try {
        const buffers: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) {
            json(413, { error: "Request too large" });
            return;
          }
          buffers.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(buffers).toString());
        if (req.url === "/config") {
          const next = playgroundConfig.parse(body);
          await open(next);
          error = "";
          return json(200, snapshot());
        }
        const command = commandSchema.parse(body);
        if (!peer) throw new Error("Reset the playground before running a command");
        if (peer.server.calls.length >= 1000)
          throw new Error("Reset the session after 1,000 requests");
        cancelled = false;
        error = "";
        task = run(command)
          .catch((failure) => {
            error = String(failure);
          })
          .finally(() => {
            busy = false;
          });
        json(202, { ok: true });
        return;
      } catch (failure) {
        json(400, { error: String(failure) });
      } finally {
        if (req.url !== "/run" || !res.writableEnded || res.statusCode !== 202) busy = false;
      }
    })().catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
  } catch (failure) {
    await peer?.close();
    throw failure;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing playground address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close: async () => {
      cancelled = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await task;
      await peer?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startPlayground(Number(process.argv[2] ?? 0));
  createLogger("im-playground").info(`IM playground: ${app.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
}
