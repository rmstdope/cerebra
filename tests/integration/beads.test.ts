import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BeadsStore } from "../../apps/server/src/beads.js";
import { SqlLocks } from "../../apps/server/src/locks.js";
import { migrate, SqlAccounts } from "../../apps/server/src/accounts.js";
import { ownerKey } from "../../packages/core/src/model.js";

describe.runIf(process.env.CEREBRA_INTEGRATION === "1")("real Beads and shared Dolt", () => {
  let pool: Pool;
  let store: BeadsStore;
  beforeAll(async () => {
    pool = createPool({
      host: "127.0.0.1", port: Number(process.env.CEREBRA_TEST_DOLT_PORT ?? 13379),
      user: "root", database: "cerebra_spike_app", connectionLimit: 25,
    });
    const locks = new SqlLocks(pool);
    await migrate(pool, locks);
    store = new BeadsStore(process.env.CEREBRA_TEST_BEADS_DIRECTORY ?? resolve(".cerebra-local/spike/project"), "spike", locks);
    await store.health();
  });
  afterAll(async () => { await pool?.end(); });
  it("stores application accounts outside Dolt commits", async () => {
    const accounts = new SqlAccounts(pool, "spike");
    const id = `user-${randomUUID().slice(0, 8)}`;
    await accounts.create(id, "test-only-long-password", ["product"]);
    const login = await accounts.login(id, "test-only-long-password");
    expect(await accounts.authenticate(login.token)).toEqual({ id, roles: ["product"] });
    await accounts.logout(login.token);
    expect(await accounts.authenticate(login.token)).toBeNull();
    const [rows] = await pool.query<RowDataPacket[]>("SELECT table_name FROM dolt_status");
    expect(rows.map((row) => row.table_name)).not.toContain("cerebra_users");
    expect(rows.map((row) => row.table_name)).not.toContain("cerebra_sessions");
    const loginAgain = await accounts.login(id, "test-only-long-password");
    await accounts.roles(id, ["qa", "ux"]);
    expect((await accounts.authenticate(loginAgain.token))?.roles).toEqual(["qa", "ux"]);
    await accounts.password(id, "replacement-test-password");
    expect(await accounts.authenticate(loginAgain.token)).toBeNull();
    await expect(accounts.login(id, "test-only-long-password")).rejects.toThrow("Invalid account");
    expect((await accounts.login(id, "replacement-test-password")).user.roles).toEqual(["qa", "ux"]);
  });
  it("creates, contends, checkpoints, releases, and fences with documented bd operations", async () => {
    const work = await store.create({
      title: `Claim test ${randomUUID()}`, description: "Integration fixture",
      acceptance: "Only one winner", data: { rank: 0, phase: "ready" },
    });
    const owners = Array.from({ length: 20 }, (_, n) => ({
      instance: `machine-${n % 2}`, agent: `agent-${n}`, token: randomUUID(),
    }));
    const claims = await Promise.all(owners.map((owner) => store.claim(work.id, owner)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find(Boolean)!;
    await store.change(work.id, claimed.assignee!, (item) => {
      item.data.checkpoint = "Checkpoint survives process recreation";
      item.data.phase = "ready";
      return item;
    });
    await store.release(work.id, claimed.assignee!);
    const next = { instance: "new-machine", agent: "new-agent", token: randomUUID() };
    expect((await store.claim(work.id, next))?.data.checkpoint).toBe("Checkpoint survives process recreation");
    await expect(store.change(work.id, claimed.assignee!, (item) => item)).rejects.toThrow("ownership changed");
    const updated = await store.change(work.id, ownerKey(next), (item) => {
      item.data.phase = "cancelled"; return item;
    });
    expect(updated.data.phase).toBe("cancelled");
  }, 120_000);
  it("deduplicates external intake under concurrent engines", async () => {
    const source = `fixture:${randomUUID()}`;
    const items = await Promise.all(Array.from({ length: 4 }, () => store.create({
      title: "Intake fixture", description: "", acceptance: "", data: { source },
    })));
    expect(new Set(items.map((item) => item.id)).size).toBe(1);
  });
  it("preserves native Beads parent links and closes children before their epic", async () => {
    const parent = await store.create({ title: "Epic fixture", description: "", acceptance: "Children finish",
      data: { kind: "epic", phase: "decomposed" } });
    const child = await store.create({ title: "Child fixture", description: "", acceptance: "Child finishes",
      data: { parent: parent.id } });
    expect(child.data.parent).toBe(parent.id);
    await store.change(child.id, "", (item) => { item.data.phase = "done"; return item; });
    await store.change(parent.id, "", (item) => { item.data.phase = "done"; return item; });
    expect((await store.get(parent.id)).data.phase).toBe("done");
  });
});
