import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { setTimeout as delay } from "node:timers/promises";
import {
  playgroundChunks,
  playgroundConfig,
  playgroundPresets,
  startPlayground,
} from "./playground.js";

describe("IM playground", () => {
  let app: Awaited<ReturnType<typeof startPlayground>>;
  beforeAll(async () => {
    app = await startPlayground();
  });
  afterAll(async () => {
    await app?.close();
  });
  const post = (path: string, body: unknown) =>
    fetch(`${app.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const state = async () => (await fetch(`${app.url}/state`)).json();
  const idle = async () => {
    for (let i = 0; i < 500; i++) {
      const result = await state();
      if (!result.busy) return result;
      await delay(10);
    }
    throw new Error("Playground did not become idle");
  };
  it.each([
    "discord",
    "telegram",
    "feishu",
    "wechat",
  ] as const)("runs %s inbound and chunked playback through the SDK", async (platform) => {
    const config = { ...playgroundPresets[platform], chunkSize: 6, step: 2, intervalMs: 0 };
    expect((await post("/config", config)).status).toBe(200);
    expect((await post("/run", { action: "inbound", text: "Hello" })).status).toBe(202);
    expect((await idle()).messages).toEqual([
      expect.objectContaining({ text: "Hello", direction: "in" }),
    ]);
    await post("/run", { action: "stream", text: "abcd👋efgh👋" });
    const result = await idle();
    expect(result.error).toBe("");
    expect(
      result.messages.filter((message: { direction: string }) => message.direction === "out"),
    ).toEqual([
      expect.objectContaining({ text: "abcd👋", edited: platform !== "wechat" }),
      expect.objectContaining({ text: "efgh👋", edited: platform !== "wechat" }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.calls.some((call: { accepted: boolean }) => call.accepted)).toBe(true);
    await post("/run", { action: "send", text: "denied", fault: "reject" });
    const rejected = await idle();
    expect(rejected.error).not.toBe("");
    expect(rejected.messages).toEqual(result.messages);
  });
  it("lets the Discord SDK retry a rate-limited request", async () => {
    await post("/config", playgroundPresets.discord);
    await post("/run", { action: "send", text: "retry", fault: "rate-limit" });
    const result = await idle();
    expect(result.error).toBe("");
    expect(result.messages).toEqual([expect.objectContaining({ text: "retry" })]);
    expect(result.calls).toContainEqual(expect.objectContaining({ status: 429, accepted: false }));
  });
  it("shows accepted remote state when the response is lost and refuses concurrent resets", async () => {
    await post("/config", { ...playgroundPresets.telegram, intervalMs: 100 });
    await post("/run", { action: "stream", text: "hello".repeat(100) });
    expect((await post("/config", playgroundPresets.discord)).status).toBe(409);
    await post("/stop", {});
    await idle();
    await post("/config", playgroundPresets.telegram);
    await post("/run", { action: "send", text: "accepted", fault: "drop" });
    const result = await idle();
    expect(result.error).not.toBe("");
    expect(result.messages).toEqual([expect.objectContaining({ text: "accepted" })]);
    expect(result.calls).toContainEqual(expect.objectContaining({ accepted: true, dropped: true }));
  });
  it("rejects invalid configuration and cross-origin commands", async () => {
    expect(playgroundConfig.safeParse({ ...playgroundPresets.wechat, mode: "edit" }).success).toBe(
      false,
    );
    expect((await post("/config", { ...playgroundPresets.discord, chunkSize: 3000 })).status).toBe(
      400,
    );
    const response = await fetch(`${app.url}/run`, {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(playgroundChunks("a👋b👋", 2)).toEqual(["a", "👋", "b", "👋"]);
  });
});
