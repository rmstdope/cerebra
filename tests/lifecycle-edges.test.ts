import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../apps/server/src/engine.js";
import { MemoryWorkStore } from "../apps/server/src/memory-store.js";
import { LocalLocks } from "../apps/server/src/locks.js";
import { FakeGitHub, FakeRuntime, testConfig } from "./helpers.js";

const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  vi.useRealTimers();
});
function setup() {
  const store = new MemoryWorkStore();
  const runtime = new FakeRuntime();
  const config = testConfig();
  const engine = new Engine(config, store, runtime, new FakeGitHub(), new LocalLocks());
  engines.push(engine);
  return { store, runtime, config, engine };
}
async function delivery(store: MemoryWorkStore) {
  return store.create({ title: "Deliver feature", description: "Feature description",
    acceptance: "Feature works", data: { rank: 0, phase: "ready" } });
}
describe("interruption and human-control edges", () => {
  it("stop terminates executions while preserving their assignments for resume", async () => {
    const context = setup();
    const work = await delivery(context.store);
    await context.engine.start();
    await context.engine.control("stop");
    expect(context.runtime.stops).toEqual(["builder-0"]);
    expect((await context.store.get(work.id)).owner?.instance).toBe("machine-a");
    await expect(context.engine.conversation("builder-0", "New request", { id: "human", roles: ["product"] }))
      .rejects.toThrow("Resume");
    await context.engine.control("resume");
    await context.engine.tick();
    expect(context.runtime.launches).toHaveLength(2);
  });
  it("recovers a blocked assignment into its visible local slot after an engine restart", async () => {
    const first = setup();
    const work = await delivery(first.store);
    await first.engine.start();
    await first.engine.providerEvent("builder-0", { type: "error", message: "Quota exhausted", recoverable: false });
    await first.engine.stop();
    const runtime = new FakeRuntime();
    const replacement = new Engine(first.config, first.store, runtime, new FakeGitHub(), new LocalLocks());
    engines.push(replacement);
    await replacement.start();
    expect((await replacement.snapshot()).agents[0]).toMatchObject({
      state: "blocked", workId: work.id, error: "Quota exhausted",
    });
    await replacement.retry("builder-0");
    await replacement.tick();
    expect(runtime.launches).toHaveLength(1);
  });
  it("does not react to exit callbacks from a superseded provider process", async () => {
    const context = setup();
    await delivery(context.store);
    await context.engine.start();
    const old = context.runtime.launches[0]!;
    old.onExit(1);
    await vi.waitFor(() => expect(context.runtime.launches).toHaveLength(2));
    old.onExit(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.runtime.launches).toHaveLength(2);
  });
  it("does not convert a provider quota block into an automatic restart loop", async () => {
    const context = setup();
    const work = await delivery(context.store);
    await context.engine.start();
    await context.engine.providerEvent("builder-0", { type: "error", message: "Quota exhausted", recoverable: false });
    context.runtime.launches[0]!.onExit(1);
    await vi.waitFor(() => expect(context.runtime.stops).toHaveLength(1));
    expect(context.runtime.launches).toHaveLength(1);
    expect((await context.store.get(work.id)).data.attempts).toBe(0);
    expect((await context.engine.snapshot()).agents[0]?.state).toBe("blocked");
  });
  it("waits for the shared store to return before recovering an execution that died offline", async () => {
    const context = setup();
    const work = await delivery(context.store);
    await context.engine.start();
    const get = vi.spyOn(context.store, "get").mockRejectedValue(new Error("Database offline"));
    context.runtime.launches[0]!.onExit(1);
    await vi.waitFor(() => expect(context.runtime.stops).toHaveLength(1));
    expect(context.runtime.launches).toHaveLength(1);
    get.mockRestore();
    await context.engine.tick();
    expect(context.runtime.launches).toHaveLength(2);
    expect((await context.store.get(work.id)).owner?.instance).toBe(context.config.instance);
  });
  it("queues all human answers while the terminal is controlled", async () => {
    const context = setup();
    await delivery(context.store);
    await context.engine.start();
    await context.engine.providerEvent("builder-0", { type: "ready", session: context.runtime.launches[0]!.session });
    await context.engine.providerEvent("builder-0", { type: "idle" });
    const first = await context.engine.ask("builder-0", "ux", "First decision?");
    const second = await context.engine.ask("builder-0", "qa", "Second decision?");
    await context.engine.terminal("builder-0", "browser", "acquire");
    await context.engine.answer(first.id, first.data.questions[0]!.id, "First answer", { id: "human", roles: ["ux"] });
    await context.engine.answer(second.id, second.data.questions[1]!.id, "Second answer", { id: "human", roles: ["qa"] });
    context.engine.releaseController("browser");
    await context.engine.tick();
    expect(context.runtime.inputs.at(-1)?.text).toContain("First answer");
    expect(context.runtime.inputs.at(-1)?.text).toContain("Second answer");
  });
  it("does not double-count concurrent human waits", async () => {
    vi.useFakeTimers();
    const context = setup();
    await delivery(context.store);
    await context.engine.start();
    const first = await context.engine.ask("builder-0", "ux", "First?");
    const second = await context.engine.ask("builder-0", "qa", "Second?");
    vi.setSystemTime(Date.now() + 1000);
    await context.engine.answer(first.id, first.data.questions[0]!.id, "One", { id: "human", roles: ["ux"] });
    vi.setSystemTime(Date.now() + 1000);
    await context.engine.answer(second.id, second.data.questions[1]!.id, "Two", { id: "human", roles: ["qa"] });
    expect((await context.store.get(first.id)).data.waitMs).toBe(2000);
  });
  it("leaves an owned item blocked rather than creating duplicate work when a provider exits after submission", async () => {
    const context = setup();
    const work = await delivery(context.store);
    await context.engine.start();
    const old = context.runtime.launches[0]!;
    await context.engine.submit("builder-0", 1);
    old.onExit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await context.store.get(work.id)).data.phase).toBe("review");
    expect(context.runtime.launches).toHaveLength(1);
  });
});
describe("work decomposition and direct conversations", () => {
  it("rejects stale human priority decisions instead of silently overwriting them", async () => {
    const context = setup();
    const first = await delivery(context.store);
    const second = await context.engine.create({ title: "Another", description: "", acceptance: "Works" });
    const revision = (await context.engine.snapshot()).rankingRevision;
    const user = { id: "product", roles: ["product" as const] };
    await context.engine.rank([second.id, first.id], user, revision);
    await expect(context.engine.rank([first.id, second.id], user, revision)).rejects.toThrow("backlog changed");
  });
  it("cancels active work and rejects further commands using its old execution credential", async () => {
    const context = setup();
    const work = await delivery(context.store);
    await context.engine.start();
    const credential = context.runtime.launches[0]!.credential;
    await context.engine.cancel(work.id, "No longer needed", { id: "product", roles: ["product"] });
    await expect(context.engine.authorizedAgent("builder-0", credential)).rejects.toThrow("no longer accepting");
    await context.engine.tick();
    expect(context.runtime.stops).toHaveLength(1);
    expect((await context.engine.snapshot()).metrics.completed).toBe(0);
  });
  it("pins a direct conversation to the requested local agent and keeps proposals unranked", async () => {
    const context = setup();
    await context.engine.start();
    const conversation = await context.engine.conversation("builder-0", "Let's design a feature", { id: "human", roles: ["ux"] });
    expect(conversation.data.kind).toBe("conversation");
    expect(conversation.owner?.instance).toBe(context.config.instance);
    const proposed = await context.engine.create({ title: "New feature", description: "", acceptance: "Works" });
    expect(proposed.data.rank).toBeNull();
    await context.engine.complete("builder-0", "Requirements agreed");
    await context.engine.tick();
    expect((await context.store.get(conversation.id)).data.phase).toBe("done");
    expect((await context.engine.snapshot()).agents[0]?.state).toBe("idle");
  });
  it("splits work into dependency-ordered children and does not count the epic as another delivery", async () => {
    const context = setup();
    const parent = await delivery(context.store);
    await context.engine.start();
    const children = await context.engine.decompose("builder-0", [
      { title: "API", description: "Implement API", acceptance: "API passes", after: [] },
      { title: "UI", description: "Implement UI", acceptance: "UI passes", after: [0] },
    ]);
    expect(children).toHaveLength(2);
    expect((await context.store.get(children[1]!.id)).data.dependencies).toEqual([children[0]!.id]);
    expect((await context.store.get(parent.id)).data.kind).toBe("epic");
    await context.engine.tick();
    expect(context.runtime.launches.at(-1)?.work.id).toBe(children[0]!.id);
  });
  it("explicit reassignment stops the old execution and leaves the slot usable", async () => {
    const context = setup();
    const work = await delivery(context.store);
    await context.engine.start();
    const oldCredential = context.runtime.launches[0]!.credential;
    await context.engine.reassign(work.id, { id: "operator", roles: ["product"] });
    await context.engine.tick();
    expect((await context.engine.snapshot()).agents[0]?.state).toBe("idle");
    await context.engine.tick();
    expect(context.runtime.launches).toHaveLength(2);
    await expect(context.engine.authorizedAgent("builder-0", oldCredential)).rejects.toThrow("Invalid execution credential");
  });
  it("rejects self-referential and cyclic decomposition before publishing children", async () => {
    const context = setup();
    await delivery(context.store);
    await context.engine.start();
    await expect(context.engine.decompose("builder-0", [
      { title: "Cycle", description: "", acceptance: "Invalid", after: [0] },
    ])).rejects.toThrow("earlier entries");
    expect(await context.store.list()).toHaveLength(1);
  });
});
