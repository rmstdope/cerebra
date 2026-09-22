import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DockerRuntime } from "../../apps/server/src/docker.js";
import { runCommand, type RunCommand } from "../../apps/server/src/command.js";
import { MemoryWorkStore } from "../../apps/server/src/memory-store.js";
import { testConfig } from "../helpers.js";

describe.runIf(process.env.CEREBRA_DOCKER === "1")("real Docker isolation and worktrees", () => {
  let directory: string;
  const containers: string[] = [];
  afterAll(async () => {
    for (const container of containers) {
      await runCommand("docker", ["rm", "--force", container]);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("runs under the host UID, limits privileges, and preserves portable worktree metadata", async () => {
    await mkdir(resolve(".cerebra-local"), { recursive: true });
    directory = await mkdtemp(resolve(".cerebra-local/docker-test-"));
    const source = join(directory, "source");
    await mkdir(source);
    await runCommand("git", ["init", "-b", "main", source]);
    await writeFile(join(source, "README"), "Fixture\n");
    await runCommand("git", ["-C", source, "add", "README"]);
    await runCommand("git", ["-C", source, "-c", "user.name=Cerebra Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "Fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"]);
    await runCommand("git", ["-C", source, "remote", "add", "origin", source]);
    const config = testConfig(`docker-${randomUUID().slice(0, 8)}`);
    config.dataDirectory = join(directory, "data");
    config.project.checkout = source;
    config.sandbox.credentialsDirectory = join(directory, "credentials");
    await mkdir(join(config.sandbox.credentialsDirectory, "builder-0"), { recursive: true });
    const store = new MemoryWorkStore();
    const work = await store.create({ title: "Container fixture", description: "", acceptance: "Isolation works" });
    // Exercise production container/worktree/PTY plumbing without consuming model credits.
    const run: RunCommand = async (file, args, options) => {
      if (file === "docker" && args[0] === "create") {
        const image = args.indexOf(config.sandbox.image);
        args = [...args.slice(0, image + 1), "node", "-e",
          "process.stdin.setRawMode(true); process.stdin.on('data', b => process.stdout.write('ECHO:'+b)); console.log('FIXTURE_READY'); setInterval(()=>{},1000)"];
      }
      return runCommand(file, args, options);
    };
    const runtime = new DockerRuntime(config, run);
    await runtime.preflight();
    let output = "";
    const session = randomUUID();
    const execution = await runtime.launch({
      agent: config.agents[0]!, work, session, credential: "fixture-not-a-real-credential",
      onTerminal: (data) => { output += data; },
      onExit: () => {},
      onError: (error) => { throw error; },
    });
    const container = `cerebra-${config.instance}-builder-0`;
    containers.push(container);
    try {
      for (let attempt = 0; attempt < 100 && !output.includes("FIXTURE_READY"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output).toContain("FIXTURE_READY");
      execution.write("hello-terminal");
      await execution.resize(100, 30);
      for (let attempt = 0; attempt < 50 && !output.includes("ECHO:hello-terminal"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output).toContain("ECHO:hello-terminal");
      const uid = (await runCommand("docker", ["exec", container, "id", "-u"])).trim();
      expect(uid).toBe(String(process.getuid!()));
      expect(uid).not.toBe("0");
      const status = await runCommand("docker", ["exec", container, "git", "status", "--porcelain"]);
      expect(status).toBe("");
      await runCommand("docker", ["exec", container, "node", "-e",
        "const fs=require('fs'); fs.writeFileSync('agent-output.txt','written in container'); fs.writeFileSync('/home/agent/home-check','ok'); JSON.parse(fs.readFileSync('/cerebra-bridge/connection.json'));"]);
      expect(await readFile(join(config.dataDirectory, "executions", work.id, "worktree", "agent-output.txt"), "utf8")).toBe("written in container");
      const inspect = JSON.parse(await runCommand("docker", ["inspect", container]))[0];
      expect(inspect.HostConfig.Privileged).toBe(false);
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(inspect.HostConfig.LogConfig.Type).toBe("none");
      expect(inspect.Mounts.some((mount: { Destination: string }) => mount.Destination === "/var/run/docker.sock")).toBe(false);
      await runCommand("docker", ["exec", container, "git", "rev-parse", "--git-common-dir"]);
      await runCommand("git", ["-C", join(config.dataDirectory, "executions", work.id, "worktree"), "status", "--porcelain"]);
    } finally { await execution.stop(); }
    await expect(access(join(config.dataDirectory, "bridges", session))).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await runtime.launch({
      agent: config.agents[0]!, work, session: randomUUID(), credential: "replacement-fixture-credential",
      onTerminal: (data) => { output += data; }, onExit: () => {}, onError: (error) => { throw error; },
    });
    try {
      expect(await runCommand("docker", ["exec", container, "node", "-e",
        "process.stdout.write(require('fs').readFileSync('agent-output.txt','utf8'))"])).toBe("written in container");
    } finally { await resumed.stop(); }
  }, 120_000);
});
