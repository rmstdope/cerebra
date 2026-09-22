import { mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const [provider, session, ...options] = process.argv.slice(2);
if (!["claude", "copilot"].includes(provider)) throw new Error("Unsupported provider.");
const home = homedir();
// Only dedicated per-agent credential files are provisioned, never a host home.
for (const [source, target] of [
  ["/cerebra-credentials/gh-hosts.yml", join(home, ".config/gh/hosts.yml")],
  ["/cerebra-credentials/claude-credentials.json", join(home, ".claude/.credentials.json")],
  ["/cerebra-credentials/copilot-config.json", join(home, ".copilot/config.json")],
]) {
  try { await access(source); }
  catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await mkdir(join(target, ".."), { recursive: true });
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) {
    // A provider's refreshed login in its dedicated home takes precedence.
    if (error.code !== "EEXIST") throw error;
  }
}
let args;
if (provider === "claude") {
  const hooks = Object.fromEntries([
    "SessionStart", "UserPromptSubmit", "MessageDisplay", "PreToolUse",
    "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure",
  ].map((event) => [event, [{ hooks: [{ type: "command",
    command: "node /opt/cerebra/sandbox/claude-hook.mjs", timeout: 20 }] }]]));
  await writeFile("/tmp/cerebra-settings.json", JSON.stringify({ hooks }));
  args = ["--dangerously-skip-permissions", "--session-id", session, "--settings", "/tmp/cerebra-settings.json"];
} else {
  const extension = join(home, ".copilot/extensions/cerebra");
  await mkdir(extension, { recursive: true });
  await copyFile("/opt/cerebra/sandbox/copilot-extension.mjs", join(extension, "extension.mjs"));
  args = ["--allow-all", "--session-id", session, "--no-auto-update",
    "--disable-builtin-mcps", "--no-remote", "--no-remote-export"];
}
for (let i = 0; i < options.length; i += 2) {
  if (!["--model", "--agent"].includes(options[i]) || !options[i + 1]) throw new Error("Invalid provider launch option.");
  args.push(options[i], options[i + 1]);
}
const child = spawn(provider, args, { stdio: "inherit" });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
