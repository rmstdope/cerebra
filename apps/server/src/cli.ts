#!/usr/bin/env node
import { readFile, mkdir, open, unlink, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateConfig, type Config } from "../../../packages/core/src/config.js";
import { humanRoles, idSchema } from "../../../packages/core/src/model.js";
import { migrate, SqlAccounts } from "./accounts.js";
import { createAgentApi, createApi } from "./api.js";
import { BeadsStore } from "./beads.js";
import { DockerRuntime } from "./docker.js";
import { Engine } from "./engine.js";
import { SqlLocks } from "./locks.js";
import { GhClient } from "./github.js";
import { runCommand } from "./command.js";
import { policyHash, registerInstance } from "./registration.js";
import type { Locks } from "./locks.js";

async function adoptWorkAuthority(config: Config, store: BeadsStore, pool: Pool, locks: Locks): Promise<void> {
  const workIdentity = JSON.stringify(await store.identity());
  const shared = policyHash(config);
  await locks.run("project-authority", async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT config_hash, work_identity FROM cerebra_project_config WHERE id = ?", [config.project.id]);
    if (rows[0] && rows[0].config_hash !== shared) {
      throw new Error("Shared project configuration differs. Coordinate the project policy revision before starting.");
    }
    if (rows[0]?.work_identity && rows[0].work_identity !== workIdentity) {
      throw new Error("This instance is connected to a different Beads project/database branch. All instances must share one authority.");
    }
    const [others] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM cerebra_project_config WHERE work_identity = ? AND id <> ?", [workIdentity, config.project.id]);
    if (others.length) throw new Error(`This Beads database is already registered as project ${String(others[0]!.id)}. Use the same project ID.`);
    await pool.query("INSERT INTO cerebra_project_config (id, config_hash, work_identity) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE work_identity = ?",
      [config.project.id, shared, workIdentity, workIdentity]);
  });
}

async function configuration(path: string): Promise<Config> {
  const config = validateConfig(JSON.parse(await readFile(path, "utf8")));
  const base = dirname(resolve(path));
  config.dataDirectory = resolve(base, config.dataDirectory);
  config.project.checkout = resolve(base, config.project.checkout);
  config.project.beadsDirectory = resolve(base, config.project.beadsDirectory);
  config.sandbox.credentialsDirectory = resolve(base, config.sandbox.credentialsDirectory);
  if (config.tls) {
    config.tls.cert = resolve(base, config.tls.cert);
    config.tls.key = resolve(base, config.tls.key);
  }
  return config;
}
async function resources(config: Config) {
  const { passwordEnv, ...database } = config.database;
  const pool = createPool({
    ...database,
    password: process.env[passwordEnv],
    connectionLimit: 30,
    enableKeepAlive: true,
  });
  const locks = new SqlLocks(pool);
  try { await migrate(pool, locks); }
  catch (error) { await pool.end(); throw error; }
  const store = new BeadsStore(config.project.beadsDirectory, config.project.id, locks);
  return { pool, locks, store, accounts: new SqlAccounts(pool, config.project.id) };
}
async function claimInstance(config: Config): Promise<() => Promise<void>> {
  await mkdir(resolve(config.dataDirectory), { recursive: true, mode: 0o700 });
  const path = resolve(config.dataDirectory, `${config.instance}.pid`);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid instance lock ${path}; inspect it before removal.`);
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      await unlink(path);
      return claimInstance(config);
    }
    throw new Error(`Instance ${config.instance} is already running as PID ${pid}.`);
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
  return () => unlink(path);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = "help", ...args] = argv;
  const configFlag = args.indexOf("--config");
  const path = configFlag >= 0 ? args[configFlag + 1] : "cerebra.config.json";
  if (!path) throw new Error("--config requires a file path.");
  const valuedFlags = new Set(["--config", "--id", "--roles", "--agent"]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--confirm") continue;
    if (!valuedFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`${flag} requires a value.`);
    index++;
  }
  if (command === "help" || command === "--help") {
    console.log(`Cerebra
  cerebra doctor --config FILE
  cerebra migrate --config FILE
  cerebra init-db --config FILE
  cerebra account --config FILE --id USER --roles product,qa
  cerebra roles --config FILE --id USER --roles product,qa
  cerebra password --config FILE --id USER
  cerebra login --config FILE --agent AGENT
  cerebra accept-policy --config FILE --confirm
  cerebra serve --config FILE

Account creation reads the password from CEREBRA_ACCOUNT_PASSWORD (12+ characters).
Database credentials come from the passwordEnv named in configuration.
No commands initialize or overwrite a consumer repository implicitly.`);
    return;
  }
  const config = await configuration(path);
  if (command === "login") {
    const agentFlag = args.indexOf("--agent");
    if (agentFlag < 0) throw new Error("--agent is required.");
    const agent = config.agents.find((entry) => entry.id === args[agentFlag + 1]);
    if (!agent) throw new Error("Unknown agent.");
    const home = resolve(config.dataDirectory, "homes", agent.id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(resolve(config.sandbox.credentialsDirectory, agent.id), { recursive: true, mode: 0o700 });
    const loginCommand = agent.provider === "claude" ? "claude auth login" : "copilot login --device-code";
    console.log(`Dedicated ${agent.name} home. Run ${loginCommand}, and gh auth login. Exit when finished.`);
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("docker", ["run", "--rm", "-it", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--mount", `type=bind,src=${home},dst=/home/agent`,
        config.sandbox.image, "bash"], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`Login container exited ${code}.`)));
    });
    return;
  }
  if (command === "init-db") {
    const { passwordEnv, database, ...connection } = config.database;
    const pool = createPool({ ...connection, password: process.env[passwordEnv] });
    try { await pool.query("CREATE DATABASE IF NOT EXISTS ??", [database]); }
    finally { await pool.end(); }
    console.log(`Application database ${database} is ready.`);
    return;
  }
  if (command === "doctor") {
    const probes: [string, () => Promise<unknown>][] = [
      ["Beads guarded updates", async () => {
        const help = await runCommand("bd", ["update", "--help"]);
        if (!help.includes("--if-assignee")) throw new Error("Upgrade bd: guarded updates required.");
      }],
      ["Docker daemon and agent image", () => new DockerRuntime(config).preflight()],
      ["GitHub authentication", () => runCommand("gh", ["auth", "status"])],
      ["Project checkout", () => stat(config.project.checkout)],
      ["Shared database", async () => {
        const resource = await resources(config);
        try { await resource.store.health(); }
        finally { await resource.pool.end(); }
      }],
    ];
    let failures = 0;
    for (const [name, run] of probes) {
      try { await run(); console.log(`OK ${name}`); }
      catch (error) {
        failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures) process.exitCode = 1;
    return;
  }
  const resource = await resources(config);
  if (command === "migrate") {
    await resource.pool.end();
    console.log("Application schema is ready. Beads schema is unchanged.");
    return;
  }
  if (command === "accept-policy") {
    try {
      if (!args.includes("--confirm")) throw new Error("Pass --confirm to adopt this project policy and invalidate mismatched running engines.");
      await resource.locks.run(`config:${config.project.id}`, async () => {
        await resource.pool.query("INSERT INTO cerebra_project_config (id, config_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_hash = ?",
          [config.project.id, policyHash(config), policyHash(config)]);
      });
      console.log("Project policy adopted. Restart every instance with matching project configuration.");
    } finally { await resource.pool.end(); }
    return;
  }
  if (["account", "roles", "password"].includes(command)) {
    try {
      const idFlag = args.indexOf("--id");
      if (idFlag < 0) throw new Error("--id is required.");
      const id = idSchema.parse(args[idFlag + 1]);
      const rolesFlag = args.indexOf("--roles");
      const roles = command === "password" ? [] : z.array(z.enum(humanRoles)).parse(
        rolesFlag < 0 ? undefined : args[rolesFlag + 1]?.split(","));
      if (command === "roles") {
        await resource.locks.run("accounts", () => resource.accounts.roles(id, roles));
        console.log(`Updated ${id}'s project role assignments.`);
        return;
      }
      const password = process.env.CEREBRA_ACCOUNT_PASSWORD;
      if (!password) throw new Error("Set CEREBRA_ACCOUNT_PASSWORD for account creation.");
      if (command === "password") {
        await resource.accounts.password(id, password);
        console.log(`Password changed and existing sessions revoked for ${id}.`);
      } else {
        await resource.accounts.create(id, password, roles);
        console.log(`Created ${id} with roles ${roles.join(", ")}.`);
      }
    } finally { await resource.pool.end(); }
    return;
  }
  if (command !== "serve") {
    await resource.pool.end();
    throw new Error(`Unknown command: ${command}`);
  }
  let release: () => Promise<void>;
  try { release = await claimInstance(config); }
  catch (error) { await resource.pool.end(); throw error; }
  let app: Awaited<ReturnType<typeof createApi>> | undefined;
  let bridge: Awaited<ReturnType<typeof createAgentApi>> | undefined;
  let heartbeat: () => Promise<void> = async () => {};
  const engine = new Engine(config, resource.store, new DockerRuntime(config), new GhClient(config.project), resource.locks, () => heartbeat());
  let resolveStartup!: () => void;
  const startupFinished = new Promise<void>((resolveReady) => { resolveStartup = resolveReady; });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      await startupFinished;
      const failures: unknown[] = [];
      for (const cleanup of [
        () => engine.stop(), () => app?.close(), () => bridge?.close(),
        () => resource.pool.end(), () => release(),
      ]) {
        try { await cleanup(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Shutdown did not complete cleanly; inspect the errors before restarting.");
    })();
    return closing;
  };
  const signal = () => {
    void close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  try {
    await adoptWorkAuthority(config, resource.store, resource.pool, resource.locks);
    heartbeat = await registerInstance(config, resource.pool, resource.locks);
    const staticDirectory = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../../dist/web/" : "./web/", import.meta.url));
    app = await createApi(engine, resource.accounts, { staticDirectory, logger: true });
    bridge = await createAgentApi(engine);
    await bridge.listen({ host: config.sandbox.bridgeHost, port: config.sandbox.bridgePort });
    await app.listen({ host: config.host, port: config.port });
    await engine.start();
    resolveStartup();
  } catch (error) {
    resolveStartup();
    await close();
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    throw error;
  }
  if (closing) { await closing; return; }
  console.log(`Cerebra ${config.instance}: ${config.publicUrl}`);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
