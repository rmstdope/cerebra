import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createConnection, type Connection } from "mysql2/promise";
import { runCommand } from "../apps/server/src/command.js";

await runCommand("dolt", ["version"]);
await runCommand("bd", ["version"]);
await mkdir(resolve(".cerebra-local"), { recursive: true });
const directory = await mkdtemp(resolve(".cerebra-local/integration-"));
let server: ChildProcess | undefined;
let connection: Connection | undefined;
try {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  const doltDirectory = join(directory, "dolt");
  const project = join(directory, "project");
  await mkdir(doltDirectory);
  await mkdir(project);
  let logs = "";
  server = spawn("dolt", ["sql-server", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: doltDirectory, stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError: Error | undefined;
  server.on("error", (error) => { serverError = error; });
  server.stdout?.on("data", (data: Buffer) => { logs = (logs + data.toString()).slice(-32_000); });
  server.stderr?.on("data", (data: Buffer) => { logs = (logs + data.toString()).slice(-32_000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`Test Dolt exited: ${logs}`);
    try {
      connection = await createConnection({ host: "127.0.0.1", port, user: "root", connectTimeout: 1000 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  if (!connection) throw new Error(`Test Dolt did not start: ${logs}`);
  await connection.query("CREATE DATABASE cerebra_spike_app");
  await connection.end();
  connection = undefined;
  await runCommand("git", ["init", "-q", "-b", "main", project]);
  await runCommand("git", ["-C", project, "config", "user.name", "Cerebra integration fixture"]);
  await runCommand("git", ["-C", project, "config", "user.email", "fixture@example.invalid"]);
  await runCommand("bd", ["init", "--server", "--external", "--server-host", "127.0.0.1",
    "--server-port", String(port), "--server-user", "root", "--database", "cerebra_spike_work",
    "--prefix", "spike", "--skip-agents", "--non-interactive"], {
    cwd: project, env: { BEADS_DOLT_PASSWORD: "" }, timeout: 120_000,
  });
  const result = await new Promise<number | null>((resolveExit, reject) => {
    const tests = spawn("pnpm", ["exec", "vitest", "run", "tests/integration/beads.test.ts"], {
      stdio: "inherit",
      env: { ...process.env, CEREBRA_INTEGRATION: "1",
        CEREBRA_TEST_DOLT_PORT: String(port), CEREBRA_TEST_BEADS_DIRECTORY: project,
        BEADS_DOLT_PASSWORD: "" },
    });
    tests.on("error", reject);
    tests.on("exit", resolveExit);
  });
  if (result !== 0) throw new Error(`Storage integration tests failed (${result}).`);
} finally {
  await connection?.end();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
