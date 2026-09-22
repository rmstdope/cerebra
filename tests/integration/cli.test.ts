import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "mysql2/promise";
import { runCommand } from "../../apps/server/src/command.js";
import { testConfig } from "../helpers.js";

describe.runIf(process.env.CEREBRA_CLI === "1")("built production CLI against real services", () => {
  let directory: string;
  let database: string;
  afterAll(async () => {
    if (database) {
      const connection = await createConnection({ host: "127.0.0.1", port: 13379, user: "root" });
      try { await connection.query("DROP DATABASE ??", [database]); }
      finally { await connection.end(); }
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("initializes accounts, starts both listeners, authenticates, and gracefully stops", async () => {
    await mkdir(resolve(".cerebra-local"), { recursive: true });
    directory = await mkdtemp(resolve(".cerebra-local/cli-test-"));
    database = `cli_${randomUUID().replaceAll("-", "")}`;
    const config = testConfig(`cli-${randomUUID().slice(0, 8)}`);
    config.database = { host: "127.0.0.1", port: 13379, user: "root", database, passwordEnv: "CEREBRA_TEST_PASSWORD" };
    config.project.id = config.instance;
    config.project.repository = "rmstdope/cerebra";
    config.project.checkout = resolve(".");
    config.project.beadsDirectory = resolve(".cerebra-local/spike/project");
    config.dataDirectory = join(directory, "data");
    config.sandbox.credentialsDirectory = join(directory, "credentials");
    config.host = "127.0.0.1";
    config.port = 15445;
    config.publicUrl = "http://127.0.0.1:15445";
    config.sandbox.bridgeHost = "127.0.0.1";
    config.sandbox.bridgePort = 15446;
    config.agents[0]!.enabled = false;
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(config));
    await runCommand("node", ["dist/cli.js", "init-db", "--config", path]);
    await runCommand("node", ["dist/cli.js", "migrate", "--config", path]);
    await runCommand("node", ["dist/cli.js", "account", "--config", path, "--id", "operator", "--roles", "product,qa"], {
      env: { CEREBRA_ACCOUNT_PASSWORD: "temporary-fixture-password" },
    });
    const server = spawn("node", [resolve("dist/cli.js"), "serve", "--config", path], {
      cwd: directory, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    server.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    server.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null) throw new Error(`CLI exited: ${output}`);
        try {
          const response = await fetch(`${config.publicUrl}/health`);
          ready = response.ok;
          if (ready) break;
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready, output).toBe(true);
      expect(await (await fetch(config.publicUrl)).text()).toContain("<title>Cerebra</title>");
      const login = await fetch(`${config.publicUrl}/api/login`, {
        method: "POST", headers: { origin: config.publicUrl, "content-type": "application/json" },
        body: JSON.stringify({ id: "operator", password: "temporary-fixture-password" }),
      });
      expect(login.status, await login.text()).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const response = await fetch(`${config.publicUrl}/api/state`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const state = await response.json() as { instance: string };
      expect(state.instance).toBe(config.instance);
    } finally {
      if (server.exitCode === null) {
        const exit = once(server, "exit");
        server.kill("SIGTERM");
        await exit;
      }
    }
    await expect(readFile(join(config.dataDirectory, `${config.instance}.pid`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
