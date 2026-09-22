import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eligible, ownerKey, parseOwner, pathsOverlap } from "../packages/core/src/model.js";
import { MemoryWorkStore } from "../apps/server/src/memory-store.js";

describe("exclusive work assignment", () => {
  it("grants exactly one of 20 competing claims", async () => {
    const store = new MemoryWorkStore();
    const work = await store.create({ title: "Feature", description: "", acceptance: "Works",
      data: { rank: 0, phase: "ready" } });
    const claims = await Promise.all(Array.from({ length: 20 }, (_, n) => store.claim(work.id, {
      instance: `machine-${n % 2}`, agent: `agent-${n}`, token: randomUUID(),
    })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    expect(await store.claim(work.id, winner.owner!)).toBeNull();
  });
  it("rejects stale writes after explicit release and reassignment", async () => {
    const store = new MemoryWorkStore();
    const work = await store.create({ title: "Feature", description: "", acceptance: "Works",
      data: { rank: 0, phase: "ready" } });
    const first = { instance: "a", agent: "agent", token: randomUUID() };
    await store.claim(work.id, first);
    await store.change(work.id, ownerKey(first), (item) => {
      item.data.phase = "ready"; return item;
    });
    await store.release(work.id, ownerKey(first));
    const second = { instance: "b", agent: "agent", token: randomUUID() };
    expect(await store.claim(work.id, second)).not.toBeNull();
    await expect(store.change(work.id, ownerKey(first), (item) => item)).rejects.toThrow("Ownership changed");
  });
  it("serializes overlapping work and respects dependencies and rank", async () => {
    const store = new MemoryWorkStore();
    const first = await store.create({ title: "One", description: "", acceptance: "Works",
      data: { phase: "ready", rank: 0, paths: ["src"] } });
    const second = await store.create({ title: "Two", description: "", acceptance: "Works",
      data: { phase: "ready", rank: 1, paths: ["src/api.ts"] } });
    await store.claim(first.id, { instance: "a", agent: "a", token: randomUUID() });
    expect(eligible(second, await store.list(), "implementer")).toBe(false);
    expect(pathsOverlap(["src/a"], ["src/ab"])).toBe(false);
    expect(pathsOverlap(["*"], ["docs"])).toBe(true);
  });
  it("round trips fenced owners", () => {
    const owner = { instance: "a", agent: "b", token: randomUUID() };
    expect(parseOwner(ownerKey(owner))).toEqual(owner);
    expect(parseOwner("someone-else")).toBeUndefined();
    expect(() => parseOwner("cerebra/broken")).toThrow("invalid owner token");
  });
  it("does not treat cancelled prerequisites as successfully delivered", async () => {
    const store = new MemoryWorkStore();
    const prerequisite = await store.create({ title: "Cancelled", description: "", acceptance: "Works",
      data: { phase: "cancelled" } });
    const dependent = await store.create({ title: "Depends on cancelled", description: "", acceptance: "Works",
      data: { phase: "ready", rank: 0, dependencies: [prerequisite.id] } });
    expect(eligible(dependent, await store.list(), "implementer")).toBe(false);
  });
});
