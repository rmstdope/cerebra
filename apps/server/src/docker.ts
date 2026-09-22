import { spawn } from "node:child_process";
import { mkdir, writeFile, access, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Config } from "../../../packages/core/src/config.js";
import { CommandError, runCommand, type RunCommand } from "./command.js";
import type { Execution, Launch, Runtime } from "./runtime.js";

export function containerArguments(config: Config, input: Launch, workspace: string, bridge: string): string[] {
  const home = resolve(config.dataDirectory, "homes", input.agent.id);
  const args = [
    "create", "--name", `cerebra-${config.instance}-${input.agent.id}`,
    "--label", `cerebra.instance=${config.instance}`, "--label", `cerebra.session=${input.session}`,
    "--interactive", "--tty", "--init",
    "--log-driver", "none",
    "--cpus", String(config.sandbox.cpus), "--memory", config.sandbox.memory,
    "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--add-host", "host.docker.internal:host-gateway",
    "--mount", `type=bind,src=${workspace},dst=${workspace}`,
    "--mount", `type=bind,src=${bridge},dst=/cerebra-bridge,readonly`,
    "--mount", `type=bind,src=${home},dst=/home/agent`,
    "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--workdir", join(workspace, "worktree"),
    "--env", "TERM=xterm-256color",
    "--env", "GIT_CONFIG_COUNT=2",
    "--env", "GIT_CONFIG_KEY_0=safe.directory",
    "--env", `GIT_CONFIG_VALUE_0=${join(workspace, "worktree")}`,
    "--env", "GIT_CONFIG_KEY_1=safe.directory",
    "--env", `GIT_CONFIG_VALUE_1=${join(workspace, "repository")}`,
    "--env", "CEREBRA_BRIDGE_FILE=/cerebra-bridge/connection.json",
    "--env", `CEREBRA_PROVIDER=${input.agent.provider}`,
    "--env", `CEREBRA_SESSION=${input.session}`,
    "--env", `CEREBRA_AGENT=${input.agent.id}`,
    "--env", `CEREBRA_WORK=${input.work.id}`,
  ];
  const credentials = resolve(config.sandbox.credentialsDirectory, input.agent.id);
  args.push("--mount", `type=bind,src=${credentials},dst=/cerebra-credentials,readonly`);
  args.push(config.sandbox.image, "node", "/opt/cerebra/sandbox/launch.mjs", input.agent.provider, input.session);
  if (input.agent.model) args.push("--model", input.agent.model);
  if (input.agent.providerAgent) args.push("--agent", input.agent.providerAgent);
  return args;
}

export class DockerRuntime implements Runtime {
  constructor(private config: Config, private run: RunCommand = runCommand) {}
  async preflight(): Promise<void> {
    await this.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    await this.run("docker", ["image", "inspect", this.config.sandbox.image]);
    for (const agent of this.config.agents.filter((item) => item.enabled)) {
      await access(resolve(this.config.sandbox.credentialsDirectory, agent.id));
    }
  }
  async launch(input: Launch): Promise<Execution> {
    const root = resolve(this.config.dataDirectory, "executions", input.work.id);
    const bridge = resolve(this.config.dataDirectory, "bridges", input.session);
    await mkdir(root, { recursive: true });
    await mkdir(bridge, { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.config.dataDirectory, "homes", input.agent.id), { recursive: true, mode: 0o700 });
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    let exists = true;
    try { await access(join(repository, "HEAD")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) {
      await this.run("git", ["clone", "--bare", "--no-hardlinks", this.config.project.checkout, repository]);
      const remote = (await this.run("git", ["remote", "get-url", "origin"], { cwd: this.config.project.checkout })).trim();
      const normalized = remote.startsWith("git@github.com:") ? `https://github.com/${remote.slice("git@github.com:".length)}` : remote;
      await this.run("git", ["--git-dir", repository, "remote", "set-url", "origin", normalized]);
    }
    let worktreeExists = true;
    try { await access(join(worktree, ".git")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      worktreeExists = false;
    }
    if (!worktreeExists) {
      const branch = input.work.data.branch ?? `cerebra/${input.work.id}`;
      const remoteBranch = (await this.run("git", ["--git-dir", repository, "ls-remote", "--heads", "origin", `refs/heads/${branch}`])).trim();
      await this.run("git", ["--git-dir", repository, "fetch", "origin", remoteBranch ? branch : this.config.project.defaultBranch]);
      let branchExists = true;
      try { await this.run("git", ["--git-dir", repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); }
      catch (error) {
        if (!(error instanceof CommandError) || error.exitCode !== 1) throw error;
        branchExists = false;
      }
      await this.run("git", ["--git-dir", repository, "worktree", "add",
        ...(branchExists ? [worktree, branch] : ["-b", branch, worktree, "FETCH_HEAD"])]);
      // Mount this task root at the same absolute path so Git's worktree pointers
      // work on both sides without exposing the consumer checkout or host home.
    }
    await writeFile(join(bridge, "connection.json"), JSON.stringify({
      url: this.config.sandbox.engineUrl, token: input.credential, agent: input.agent.id,
      session: input.session, work: input.work.id,
    }), { mode: 0o600 });
    const name = `cerebra-${this.config.instance}-${input.agent.id}`;
    const existing = (await this.run("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"])).trim();
    if (existing) {
      const label = (await this.run("docker", ["inspect", "--format", '{{index .Config.Labels "cerebra.instance"}}', existing])).trim();
      if (label !== this.config.instance) throw new Error(`Container ${name} is not owned by this instance.`);
      await this.run("docker", ["rm", "--force", existing]);
    }
    if (process.getuid?.() === 0) throw new Error("Run Cerebra as a non-root host user.");
    const args = containerArguments(this.config, input, root, bridge);
    const container = (await this.run("docker", args)).trim();
    const child = spawn("docker", ["start", "--attach", "--interactive", container], { stdio: ["pipe", "pipe", "pipe"] });
    let attached = false;
    let startupError: Error | undefined;
    child.stdout.on("data", (data: Buffer) => input.onTerminal(data.toString()));
    child.stderr.on("data", (data: Buffer) => input.onTerminal(data.toString()));
    child.on("error", (error) => {
      if (attached) input.onError(error);
      else startupError = error;
    });
    child.stdin.on("error", (error) => {
      if (attached) input.onError(error);
      else startupError = error;
    });
    child.on("close", (code) => {
      if (attached) input.onExit(code);
      else startupError = new Error(`Container exited during startup (${code ?? "signal"}).`);
    });
    let running = false;
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (startupError) throw startupError;
        running = (await this.run("docker", ["inspect", "--format", "{{.State.Running}}", container])).trim() === "true";
        if (running) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!running) throw new Error("Container did not become running before the startup timeout.");
      await this.run("docker", ["exec", container, "stty", "-F", "/dev/pts/0", "cols", "120", "rows", "35"]);
      if (startupError) throw startupError;
    } catch (error) {
      try { await this.run("docker", ["stop", "--time", "3", container]); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Container startup and cleanup failed for ${container}.`);
      }
      await rm(bridge, { recursive: true, force: true });
      throw error;
    }
    attached = true;
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    return {
      session: input.session,
      write(data) {
        if (stopped || stopPromise || !child.stdin.writable) throw new Error("The agent terminal is not connected.");
        child.stdin.write(data);
      },
      resize: async (cols, rows) => {
        await this.run("docker", ["exec", container, "stty", "-F", "/dev/pts/0", "cols", String(cols), "rows", String(rows)]);
      },
      stop: async () => {
        if (stopped) return;
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          await this.run("docker", ["stop", "--time", "10", container]);
          await rm(bridge, { recursive: true, force: true });
          stopped = true;
        })();
        try { await stopPromise; }
        finally { stopPromise = undefined; }
      },
    };
  }
}
