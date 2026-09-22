import { spawn } from "node:child_process";

export class CommandError extends Error {
  constructor(
    public readonly executable: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`${executable} failed (${exitCode ?? "signal"}): ${stderr.trim().slice(0, 2000)}`);
    this.name = "CommandError";
  }
}
export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
}
export type RunCommand = (file: string, args: string[], options?: CommandOptions) => Promise<string>;

export const runCommand: RunCommand = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail(new CommandError(file, null, `Timed out after ${options.timeout ?? 60_000}ms`));
  }, options.timeout ?? 60_000);
  child.on("error", fail);
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") fail(error);
  });
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
    if (stdout.length > 16 * 1024 * 1024) {
      child.kill("SIGKILL");
      fail(new Error(`${file} exceeded the command output limit.`));
    }
  });
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-64_000); });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) reject(new CommandError(file, code, stderr));
    else resolve(stdout);
  });
  child.stdin.end(options.input);
});
