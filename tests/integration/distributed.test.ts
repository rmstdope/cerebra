import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createPool } from "mysql2/promise";
import { BeadsStore } from "../../apps/server/src/beads.js";
import { SqlLocks } from "../../apps/server/src/locks.js";
import { runCommand } from "../../apps/server/src/command.js";

describe.runIf(process.env.CEREBRA_DISTRIBUTED === "1")("macOS and Linux VM shared authority", () => {
  it("keeps 20 assignments unique while two independent engines each fill ten slots", async () => {
    const pool = createPool({ host: "127.0.0.1", port: 13379, user: "root", database: "cerebra_spike_app", connectionLimit: 25 });
    const store = new BeadsStore(resolve(".cerebra-local/spike/project"), "spike", new SqlLocks(pool));
    const fixture = await mkdtemp(resolve(".cerebra-local/distributed-"));
    const workIds: string[] = [];
    try {
      await runCommand("pnpm", ["exec", "tsup", "tests/distributed-worker.ts", "--format", "esm",
        "--out-dir", ".cerebra-local/worker-build"]);
      await rename(resolve(".cerebra-local/worker-build/distributed-worker.js"),
        resolve(".cerebra-local/worker-build/distributed-worker.mjs"));
      const linuxDirectory = join(fixture, "linux-project");
      await mkdir(linuxDirectory);
      const home = join(fixture, "home");
      await mkdir(home);
      const source = resolve(".cerebra-local/spike/project");
      await runCommand("git", ["clone", "--no-hardlinks", source, linuxDirectory]);
      const tools = resolve(".cerebra-local/tools/beads-linux");
      const image = "cerebra-agent:local";
      const base = ["run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`,
        "--mount", `type=bind,src=${linuxDirectory},dst=/fixture`,
        "--mount", `type=bind,src=${home},dst=/home/agent`,
        "--mount", `type=bind,src=${tools},dst=/tools,readonly`,
        "--env", "PATH=/tools:/usr/local/bin:/usr/bin:/bin",
        "--env", "BEADS_DOLT_SERVER_HOST=host.lima.internal",
        "--env", "BEADS_DOLT_SERVER_PORT=13379",
        "--env", "BEADS_DOLT_SERVER_USER=root",
        "--env", "BEADS_DOLT_SERVER_MODE=1",
        "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=safe.directory", "--env", "GIT_CONFIG_VALUE_0=/fixture",
        "--workdir", "/fixture"];
      // A fresh clone uses the same server/database, never pull/push synchronization.
      await runCommand("docker", [...base, image, "bd", "bootstrap", "--yes"]);
      for (let i = 0; i < 20; i++) {
        const item = await store.create({ title: `Distributed assignment ${i}`, description: "Fixture",
          acceptance: "One engine owns it", data: { phase: "ready", rank: i } });
        workIds.push(item.id);
      }
      const startAt = String(Date.now() + 3000);
      const host = runCommand("node", [resolve(".cerebra-local/worker-build/distributed-worker.mjs")], {
        env: { TEST_INSTANCE: "macos-a", TEST_BEADS_DIRECTORY: source,
          TEST_WORK_IDS: JSON.stringify(workIds), TEST_START_AT: startAt },
        timeout: 180_000,
      });
      const linux = runCommand("docker", [...base,
        "--mount", `type=bind,src=${resolve(".cerebra-local/worker-build")},dst=/worker,readonly`,
        "--mount", `type=bind,src=${resolve("node_modules")},dst=/node_modules,readonly`,
        "--env", "TEST_INSTANCE=linux-b", "--env", "TEST_BEADS_DIRECTORY=/fixture",
        "--env", "TEST_DATABASE_HOST=host.lima.internal",
        "--env", `TEST_WORK_IDS=${JSON.stringify(workIds)}`, "--env", `TEST_START_AT=${startAt}`,
        image, "node", "/worker/distributed-worker.mjs"], { timeout: 180_000 });
      const results = (await Promise.all([host, linux])).map((result) =>
        JSON.parse(result.trim()) as { instance: string; assignments: string[] });
      expect(results.map((result) => result.assignments.length)).toEqual([10, 10]);
      expect(new Set(results.flatMap((result) => result.assignments)).size).toBe(20);
      for (const id of workIds) expect((await store.get(id)).owner?.instance).toMatch(/macos-a|linux-b/);
    } finally {
      for (const id of workIds) {
        const item = await store.get(id);
        await store.change(id, item.assignee ?? "", (work) => { work.data.phase = "cancelled"; return work; });
      }
      await pool.end();
      await rm(fixture, { recursive: true, force: true });
    }
  }, 240_000);
});
