import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, createAgentApi } from "../apps/server/src/api.js";
import { Engine } from "../apps/server/src/engine.js";
import { MemoryAccounts } from "../apps/server/src/accounts.js";
import { MemoryWorkStore } from "../apps/server/src/memory-store.js";
import { LocalLocks } from "../apps/server/src/locks.js";
import { FakeGitHub, FakeRuntime, testConfig } from "./helpers.js";
import { once } from "node:events";
import WebSocket from "ws";

describe("local authenticated API", () => {
  let app: Awaited<ReturnType<typeof createApi>>;
  let bridge: Awaited<ReturnType<typeof createAgentApi>>;
  let engine: Engine;
  let session: string;
  beforeEach(async () => {
    engine = new Engine(testConfig(), new MemoryWorkStore(), new FakeRuntime(), new FakeGitHub(), new LocalLocks());
    const accounts = new MemoryAccounts();
    await accounts.create("operator", "test-only-long-password", ["product", "ux", "qa"]);
    app = await createApi(engine, accounts);
    bridge = await createAgentApi(engine);
    const login = await app.inject({ method: "POST", url: "/api/login",
      headers: { origin: "http://localhost:4545" }, payload: { id: "operator", password: "test-only-long-password" } });
    expect(login.statusCode).toBe(200);
    session = login.cookies[0]!.value;
  });
  afterEach(async () => { await engine.stop(); await app.close(); await bridge.close(); });
  it("requires login and same-origin writes", async () => {
    expect((await app.inject("/api/state")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/control", cookies: { cerebra: session },
      headers: { origin: "https://untrusted.example" }, payload: { action: "resume" } })).statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: "/api/state", cookies: { cerebra: session } });
    expect(response.statusCode).toBe(200);
    expect(response.json().instance).toBe("machine-a");
  });
  it("does not bypass authentication with alternate URL encodings", async () => {
    for (const url of ["/%61pi/state", "/api%2fstate", "/api//state", "/api/./state", "//api/state", "/api/state?x=/health"]) {
      const response = await app.inject(url);
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.body, url).not.toContain('"agents"');
    }
  });
  it("creates unranked work, validates payloads, and records human ranking", async () => {
    const headers = { origin: "http://localhost:4545" };
    const cookies = { cerebra: session };
    const create = await app.inject({ method: "POST", url: "/api/work", headers, cookies,
      payload: { title: "Build feature", acceptance: "A person can use it", data: { rank: 0, phase: "ready" } } });
    expect(create.statusCode).toBe(200);
    expect(create.json().data.rank).toBeNull();
    const revision = (await engine.snapshot()).rankingRevision;
    const rank = await app.inject({ method: "POST", url: "/api/rank", headers, cookies, payload: { ids: [create.json().id], revision } });
    expect(rank.statusCode).toBe(200);
    expect((await engine.store.get(create.json().id)).data.phase).toBe("ready");
    expect((await app.inject({ method: "POST", url: "/api/work", headers, cookies, payload: { title: "" } })).statusCode).toBe(400);
  });
  it("rejects unauthenticated sandbox requests and revokes logout sessions", async () => {
    expect((await bridge.inject({ method: "POST", url: "/agent/builder-0/work", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/logout", headers: { origin: "http://localhost:4545" },
      cookies: { cerebra: session }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/state", cookies: { cerebra: session } })).statusCode).toBe(401);
  });
  it("closes an authenticated live connection on logout", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http:", "ws:")}/api/events`, {
      origin: "http://localhost:4545", headers: { cookie: `cerebra=${session}` },
    });
    try {
      await once(socket, "open");
      const closed = once(socket, "close");
      await app.inject({ method: "POST", url: "/api/logout", headers: { origin: "http://localhost:4545" },
        cookies: { cerebra: session }, payload: {} });
      const [code] = await closed;
      expect(code).toBe(1008);
    } finally { socket.terminate(); }
  });
});
