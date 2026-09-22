import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../apps/server/src/engine.js";
import { MemoryWorkStore } from "../apps/server/src/memory-store.js";
import { LocalLocks } from "../apps/server/src/locks.js";
import { ownerKey } from "../packages/core/src/model.js";
import { FakeGitHub, FakeRuntime, head, testConfig } from "./helpers.js";

const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  vi.useRealTimers();
});
function setup(instance = "machine-a", store = new MemoryWorkStore(), count = 1) {
  const runtime = new FakeRuntime();
  const github = new FakeGitHub();
  const config = testConfig(instance, count);
  const engine = new Engine(config, store, runtime, github, new LocalLocks());
  engines.push(engine);
  return { engine, runtime, github, config, store };
}
async function work(store: MemoryWorkStore, title = "Feature") {
  return store.create({ title, description: "Implement", acceptance: "Works",
    data: { rank: 0, phase: "ready" } });
}
describe("fleet lifecycle", () => {
  it("runs 20 independent assignments on two engines sharing one backlog", async () => {
    const store = new MemoryWorkStore();
    for (let i = 0; i < 20; i++) await work(store, `Feature ${i}`);
    const a = setup("machine-a", store, 10);
    const b = setup("machine-b", store, 10);
    await Promise.all([a.engine.start(), b.engine.start()]);
    expect(a.runtime.launches).toHaveLength(10);
    expect(b.runtime.launches).toHaveLength(10);
    const ids = [...a.runtime.launches, ...b.runtime.launches].map((launch) => launch.work.id);
    expect(new Set(ids).size).toBe(20);
  });
  it("keeps human waits in their original slot and rejects remote or duplicate answers", async () => {
    const a = setup();
    const item = await work(a.store);
    await a.engine.start();
    const launch = a.runtime.launches[0]!;
    await a.engine.providerEvent("builder-0", { type: "ready", session: launch.session });
    await a.engine.providerEvent("builder-0", { type: "idle" });
    const waiting = await a.engine.ask("builder-0", "ux", "Should the button be blue?");
    expect((await a.engine.snapshot()).agents[0]?.state).toBe("waiting");
    const b = setup("machine-b", a.store);
    await b.engine.start();
    expect(b.runtime.launches).toHaveLength(0);
    const question = waiting.data.questions[0]!;
    await expect(b.engine.answer(item.id, question.id, "Blue", { id: "designer", roles: ["ux"] }))
      .rejects.toThrow("owning machine");
    await a.engine.answer(item.id, question.id, "Blue", { id: "designer", roles: ["ux"] });
    expect(a.runtime.launches).toHaveLength(1);
    expect(a.runtime.inputs.at(-1)?.text).toContain("Blue");
    expect(a.runtime.stops).toHaveLength(0);
    await expect(a.engine.answer(item.id, question.id, "Red", { id: "designer", roles: ["ux"] }))
      .rejects.toThrow("already answered");
  });
  it("does not time out human waits or running tools", async () => {
    vi.useFakeTimers();
    const context = setup();
    await work(context.store);
    await context.engine.start();
    await context.engine.providerEvent("builder-0", { type: "tool_start", id: "long-build", description: "build" });
    vi.setSystemTime(Date.now() + 4 * 60 * 60_000);
    await context.engine.tick();
    expect(context.runtime.launches).toHaveLength(1);
    await context.engine.ask("builder-0", "product", "Need input");
    await context.engine.providerEvent("builder-0", { type: "tool_end", id: "long-build" });
    vi.setSystemTime(Date.now() + 8 * 60 * 60_000);
    await context.engine.tick();
    expect(context.runtime.launches).toHaveLength(1);
  });
  it("bounds a crash loop to three recoveries and retains the owner", async () => {
    const context = setup();
    const item = await work(context.store);
    await context.engine.start();
    for (let i = 0; i < 4; i++) {
      context.runtime.launches.at(-1)!.onExit(1);
      await vi.waitFor(async () => {
        const current = await context.store.get(item.id);
        expect(i === 3 ? current.data.phase : current.data.recoveries).toBe(i === 3 ? "blocked" : i + 1);
      });
    }
    expect(context.runtime.launches).toHaveLength(4);
    expect((await context.store.get(item.id)).owner?.instance).toBe("machine-a");
  });
  it("retains durable checkpoints when a new engine recovers the same machine", async () => {
    const first = setup();
    const item = await work(first.store);
    await first.engine.start();
    await first.engine.checkpoint("builder-0", "Implementation halfway done");
    await first.engine.stop();
    const second = setup("machine-a", first.store);
    await second.engine.start();
    expect(second.runtime.launches[0]?.work.data.checkpoint).toBe("Implementation halfway done");
    expect((await second.store.get(item.id)).data.recoveries).toBe(1);
  });
  it("serializes chat versus terminal input on the same session", async () => {
    const context = setup();
    await work(context.store);
    await context.engine.start();
    const session = context.runtime.launches[0]!.session;
    await context.engine.providerEvent("builder-0", { type: "ready", session });
    await context.engine.providerEvent("builder-0", { type: "idle" });
    await context.engine.terminal("builder-0", "browser-a", "acquire");
    await expect(context.engine.chat("builder-0", "hello")).rejects.toThrow("Release terminal");
    await expect(context.engine.terminal("builder-0", "browser-b", "acquire")).rejects.toThrow("Another browser");
    await context.engine.terminal("builder-0", "browser-a", "input", "hello\r");
    await context.engine.terminal("builder-0", "browser-a", "release");
    await context.engine.chat("builder-0", "Second message");
    expect(context.runtime.launches).toHaveLength(1);
    expect(context.runtime.inputs.at(-1)?.text).toContain("Second message");
    await context.engine.providerEvent("builder-0", { type: "idle" });
    await expect(context.engine.chat("builder-0", "bad\u001btext")).rejects.toThrow("control characters");
  });
  it("fails closed when the shared backlog goes offline", async () => {
    const context = setup();
    await work(context.store);
    vi.spyOn(context.store, "list").mockRejectedValue(new Error("Database offline"));
    await expect(context.engine.start()).rejects.toThrow("Database offline");
    expect(context.runtime.launches).toHaveLength(0);
    expect(context.github.merges).toHaveLength(0);
  });
});
describe("delivery checkpoints", () => {
  it("records separate-session review on GitHub, merges, and dispatches only human-authorized deployment", async () => {
    vi.useFakeTimers();
    const context = setup();
    context.config.agents.push({ id: "reviewer", name: "Reviewer", role: "reviewer",
      provider: "claude", instructions: "Review independently.", enabled: true });
    context.config.project.checkpoints = [
      { id: "security", description: "Security check evidence" },
      { id: "demo", description: "QA demonstration", humanRole: "qa" },
    ];
    // Construct after setting up the roster.
    const engine = new Engine(context.config, context.store, context.runtime, context.github, new LocalLocks());
    engines.push(engine);
    const item = await work(context.store);
    await engine.start();
    const authorSession = context.runtime.launches[0]!.session;
    await engine.submit("builder-0", 1);
    await engine.tick();
    const reviewer = context.runtime.launches.find((launch) => launch.agent.id === "reviewer")!;
    expect(reviewer.session).not.toBe(authorSession);
    await engine.agentGate("reviewer", "security", head, "Security checks passed.");
    await expect(engine.agentGate("reviewer", "demo", head, "Looks fine")).rejects.toThrow("qa human role");
    await engine.review("reviewer", "approved", "Tests and implementation satisfy acceptance.");
    vi.setSystemTime(Date.now() + 61_000);
    await engine.tick();
    expect(context.github.reviews).toHaveLength(1);
    expect(context.github.merges).toEqual([]);
    await expect(engine.gate(item.id, "demo", "c".repeat(40), true, "Old head", { id: "qa", roles: ["qa"] }))
      .rejects.toThrow("current PR head");
    await engine.gate(item.id, "demo", head, true, "Demo accepted", { id: "qa", roles: ["qa"] });
    vi.setSystemTime(Date.now() + 61_000);
    await engine.tick();
    expect(context.github.merges).toEqual([1]);
    expect(context.github.dispatches).toHaveLength(0);
    await engine.deploy(item.id, { id: "product", roles: ["product"] });
    vi.setSystemTime(Date.now() + 61_000);
    await engine.tick();
    expect(context.github.dispatches).toHaveLength(1);
    expect(context.github.dispatches[0]?.ref).toBe("b".repeat(40));
    context.github.run = { id: 42, url: "https://github.com/example/fixture/actions/runs/42", status: "completed", conclusion: "success" };
    vi.setSystemTime(Date.now() + 61_000);
    await engine.tick();
    expect((await context.store.get(item.id)).data.phase).toBe("deployed");
  });
  it("never retries an uncertain workflow dispatch automatically", async () => {
    vi.useFakeTimers();
    const context = setup();
    const item = await work(context.store);
    await context.engine.start();
    const current = await context.store.get(item.id);
    await context.store.change(item.id, current.assignee!, (entry) => {
      entry.data.phase = "merged"; entry.data.pr = 1; return entry;
    });
    context.github.pr.state = "MERGED"; context.github.pr.mergeCommit = { oid: head };
    context.github.failDispatch = true;
    await context.engine.deploy(item.id, { id: "product", roles: ["product"] });
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      await context.engine.tick();
    }
    expect(context.github.dispatches).toHaveLength(1);
    expect((await context.store.get(item.id)).data.deployment?.state).toBe("uncertain");
    await context.engine.reconcileDeployment(item.id, "Confirmed no workflow run exists.", { id: "product", roles: ["product"] });
    expect((await context.store.get(item.id)).data.phase).toBe("merged");
    expect(context.github.dispatches).toHaveLength(1);
  });
  it("turns failed post-merge verification into unranked urgent work", async () => {
    const context = setup();
    const item = await work(context.store);
    await context.store.change(item.id, "", (entry) => { entry.data.phase = "merged"; return entry; });
    const bug = await context.engine.verify(item.id, false, "Broken in browser", { id: "qa", roles: ["qa"] });
    expect(bug.title).toContain("Urgent");
    expect(bug.data.rank).toBeNull();
    expect(bug.data.phase).toBe("backlog");
  });
});
