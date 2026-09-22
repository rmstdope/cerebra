import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentApi } from "../../apps/server/src/api.js";
import { DockerRuntime } from "../../apps/server/src/docker.js";
import { Engine } from "../../apps/server/src/engine.js";
import { LocalLocks } from "../../apps/server/src/locks.js";
import { MemoryWorkStore } from "../../apps/server/src/memory-store.js";
import { runCommand } from "../../apps/server/src/command.js";
import { FakeGitHub, testConfig } from "../helpers.js";

describe.runIf(process.env.CEREBRA_DOCKER === "1")("real provider startup without account extraction", () => {
  it.each(["claude", "copilot"] as const)("starts %s in the sandbox and round-trips the scoped agent API", async (provider) => {
    await mkdir(resolve(".cerebra-local"), { recursive: true });
    const root = await mkdtemp(resolve(".cerebra-local/provider-startup-"));
    const config = testConfig(`provider-${randomUUID().slice(0, 8)}`);
    config.agents[0]!.provider = provider;
    config.dataDirectory = join(root, "data");
    config.project.checkout = join(root, "source");
    config.sandbox.credentialsDirectory = join(root, "credentials");
    await mkdir(config.project.checkout);
    await mkdir(join(config.sandbox.credentialsDirectory, "builder-0"), { recursive: true });
    await runCommand("git", ["init", "-b", "main", config.project.checkout]);
    await writeFile(join(config.project.checkout, "README"), "Public synthetic provider-startup fixture. No customer code.\n");
    await runCommand("git", ["-C", config.project.checkout, "add", "README"]);
    await runCommand("git", ["-C", config.project.checkout, "-c", "user.name=Cerebra Test",
      "-c", "user.email=test@example.invalid", "commit", "-m",
      "Fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"]);
    await runCommand("git", ["-C", config.project.checkout, "remote", "add", "origin", config.project.checkout]);
    const store = new MemoryWorkStore();
    const work = await store.create({
      title: "Provider startup only", description: "Do not contact any external model.",
      acceptance: "Container starts and the local Cerebra bridge works.", data: { phase: "ready", rank: 0 },
    });
    const engine = new Engine(config, store, new DockerRuntime(config), new FakeGitHub(), new LocalLocks());
    const bridge = await createAgentApi(engine);
    const address = await bridge.listen({ port: 0, host: "127.0.0.1" });
    config.sandbox.engineUrl = address.replace("127.0.0.1", "host.lima.internal");
    const container = `cerebra-${config.instance}-builder-0`;
    try {
      await engine.start();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const state = await engine.snapshot();
      expect(state.agents[0]?.workId).toBe(work.id);
      const inspection = JSON.parse(await runCommand("docker", ["inspect", container]))[0];
      expect(inspection.State.Running).toBe(true);
      const response = JSON.parse(await runCommand("docker", ["exec", container,
        "cerebra", "checkpoint", "Local authenticated bridge reached from a real provider container."]));
      expect(response.data.checkpoint).toContain("bridge reached");
      expect((await store.get(work.id)).data.checkpoint).toContain("bridge reached");
      await engine.terminal("builder-0", "startup-test", "acquire");
      await engine.terminal("builder-0", "startup-test", "resize", undefined, 120, 35);
      await vi.waitFor(() => expect(engine.terminalSnapshot("builder-0").frames.length).toBeGreaterThan(0), { timeout: 20_000 });
      const terminal = engine.terminalSnapshot("builder-0").frames.map((frame) => frame.data).join("");
      expect(terminal.length).toBeGreaterThan(0);
      expect(terminal).not.toContain("Cannot find module");
      expect(terminal).not.toContain("Unknown option");
    } finally {
      await engine.stop();
      await bridge.close();
      const existing = (await runCommand("docker", ["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"])).trim();
      if (existing) await runCommand("docker", ["rm", "--force", existing]);
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
