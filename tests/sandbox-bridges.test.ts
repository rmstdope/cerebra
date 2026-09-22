import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../apps/server/src/command.js";
import { eventFromClaude } from "../apps/server/src/runtime.js";

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return JSON.parse(body);
}
describe("provider bridge scripts", () => {
  it("forwards a real Claude hook payload without modifying displayed text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cerebra-hook-"));
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      void jsonBody(request).then((body) => {
        received.push(body);
        expect(request.headers.authorization).toBe("Bearer fixture-scoped-token");
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected listening address.");
    const path = join(directory, "connection.json");
    await writeFile(path, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: "fixture-scoped-token", agent: "builder" }));
    const payload = {
      hook_event_name: "MessageDisplay", session_id: "session-1",
      message_id: "message-1", turn_id: "turn-1", index: 0, final: false,
      delta: "A structured streamed line.\n",
    };
    try {
      expect(await runCommand("node", [resolve("sandbox/claude-hook.mjs")], {
        env: { CEREBRA_BRIDGE_FILE: path }, input: JSON.stringify(payload),
      })).toBe("{}");
      expect(received).toEqual([payload]);
      expect(eventFromClaude(payload)).toEqual({
        type: "delta", id: "message-1", text: "A structured streamed line.\n", final: false,
      });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("joins the foreground Copilot session and subscribes before ready acknowledgement", async () => {
    const source = await readFile("sandbox/copilot-extension.mjs", "utf8");
    const directory = await mkdtemp(join(tmpdir(), "cerebra-extension-"));
    const extension = join(directory, "extension.mjs");
    // Replace only the host-injected transports; execute the checked-in adapter.
    await writeFile(extension, source
      .replace('"@github/copilot-sdk/extension"', '"./sdk.mjs"')
      .replace('"/opt/cerebra/sandbox/connection.mjs"', '"./connection.mjs"'));
    await writeFile(join(directory, "sdk.mjs"), `
export async function joinSession(options) {
  if (!options.streaming) throw new Error("Streaming must be enabled");
  return { sessionId: "foreground-session", on(callback) { globalThis.listener = callback; } };
}`);
    await writeFile(join(directory, "connection.mjs"), `
export async function call(path, event) {
  console.log(JSON.stringify(event));
  if (event.type === "ready") {
    if (!globalThis.listener) throw new Error("Ready before event subscription");
    globalThis.listener({ type: "user.message", id: "u1", data: { content: "Hello" } });
    globalThis.listener({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hi" } });
    globalThis.listener({ type: "assistant.message", data: { messageId: "m1", content: "Hi there" } });
    globalThis.listener({ type: "assistant.usage", id: "usage1", data: { inputTokens: 10, outputTokens: 2 } });
    globalThis.listener({ type: "session.idle", data: {} });
  }
  return { ok: true };
}`);
    try {
      const events = (await runCommand("node", [extension])).trim().split("\n").map((line) => JSON.parse(line));
      expect(events.map((event) => event.type)).toEqual(["ready", "user", "delta", "message", "usage", "idle"]);
      expect(events[0].session).toBe("foreground-session");
      expect(events[2]).toEqual({ type: "delta", id: "m1", text: "Hi" });
      expect(events[4]).not.toHaveProperty("nanoAiu");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
