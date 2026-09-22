import { describe, expect, it } from "vitest";
import { eventFromClaude } from "../apps/server/src/runtime.js";
import { containerArguments } from "../apps/server/src/docker.js";
import { testConfig } from "./helpers.js";
import { MemoryWorkStore } from "../apps/server/src/memory-store.js";
import { randomUUID } from "node:crypto";
import { Engine } from "../apps/server/src/engine.js";
import { LocalLocks } from "../apps/server/src/locks.js";
import { FakeRuntime, FakeGitHub } from "./helpers.js";

describe("provider contracts", () => {
  it("uses structured Claude hooks, never terminal scraping", () => {
    expect(eventFromClaude({
      hook_event_name: "MessageDisplay", message_id: "message-1", delta: "hello", final: false,
    })).toEqual({ type: "delta", id: "message-1", text: "hello", final: false });
    expect(eventFromClaude({ hook_event_name: "StopFailure", error: "rate_limit" }))
      .toEqual({ type: "error", message: "rate_limit", recoverable: false });
    expect(eventFromClaude({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tool-1" }))
      .toEqual({ type: "tool_start", id: "tool-1", description: "Bash" });
  });
  it("does not grant host-level privileges or mount the host home or Docker socket", async () => {
    const config = testConfig();
    const store = new MemoryWorkStore();
    const work = await store.create({ title: "Feature", description: "", acceptance: "Works" });
    const args = containerArguments(config, {
      agent: config.agents[0]!, work, session: randomUUID(), credential: "fixture",
      onTerminal() {}, onExit() {}, onError() {},
    }, "/fixture/isolated-work", "/fixture/bridge");
    expect(args).toContain("no-new-privileges");
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args.join(" ")).not.toContain("GITHUB_TOKEN");
    expect(args.join(" ")).not.toContain("CEREBRA_DATABASE_PASSWORD");
  });
  it("deduplicates structured usage while preserving unpriced request counts", async () => {
    const store = new MemoryWorkStore();
    await store.create({ title: "Feature", description: "", acceptance: "Works", data: { phase: "ready", rank: 0 } });
    const engine = new Engine(testConfig(), store, new FakeRuntime(), new FakeGitHub(), new LocalLocks());
    await engine.start();
    try {
      const usage = { type: "usage" as const, id: "request-1", inputTokens: 100, outputTokens: 20, nanoAiu: 1e9 };
      await Promise.all([engine.providerEvent("builder-0", usage), engine.providerEvent("builder-0", usage)]);
      await engine.providerEvent("builder-0", { type: "usage", id: "request-2", inputTokens: 30 });
      expect((await engine.snapshot()).metrics.usage).toEqual({
        requests: 2, inputTokens: 130, outputTokens: 20, nanoAiu: 1e9, unpricedRequests: 1,
      });
    } finally { await engine.stop(); }
  });
});
