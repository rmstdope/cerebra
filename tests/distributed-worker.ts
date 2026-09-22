import { createPool } from "mysql2/promise";
import { BeadsStore } from "../apps/server/src/beads.js";
import { SqlLocks } from "../apps/server/src/locks.js";
import { Engine } from "../apps/server/src/engine.js";
import { FakeGitHub, FakeRuntime, testConfig } from "./helpers.js";
import type { WorkStore } from "../packages/core/src/model.js";

const pool = createPool({
  host: process.env.TEST_DATABASE_HOST ?? "127.0.0.1",
  port: Number(process.env.CEREBRA_TEST_DOLT_PORT ?? 13379),
  user: "root", database: "cerebra_spike_app", connectionLimit: 25,
});
try {
  const instance = process.env.TEST_INSTANCE!;
  const locks = new SqlLocks(pool);
  const underlying = new BeadsStore(process.env.TEST_BEADS_DIRECTORY!, "spike", locks);
  const ids: string[] = JSON.parse(process.env.TEST_WORK_IDS!);
  const store: WorkStore = {
    health: () => underlying.health(),
    list: async () => (await underlying.list()).filter((work) => ids.includes(work.id))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
    get: (id) => underlying.get(id), create: (input) => underlying.create(input),
    claim: (id, owner) => underlying.claim(id, owner),
    change: (id, expected, change) => underlying.change(id, expected, change),
    release: (id, expected) => underlying.release(id, expected),
  };
  const runtime = new FakeRuntime();
  const engine = new Engine(testConfig(instance, 10), store, runtime, new FakeGitHub(), locks);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(process.env.TEST_START_AT) - Date.now())));
  try {
    await engine.start();
    console.log(JSON.stringify({ instance, assignments: runtime.launches.map((launch) => launch.work.id) }));
  } finally { await engine.stop(); }
} finally { await pool.end(); }
