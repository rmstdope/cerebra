import { query } from '@anthropic-ai/claude-agent-sdk';

import { exitCodeFor, readRunnerConfig } from './runner-config.js';
import { runRunnerSession } from './session.js';

try {
  const config = readRunnerConfig(process.env);
  const end = await runRunnerSession({
    ...config,
    query,
    // Claude must use the same state directory the run's skills were installed into.
    env: { ...process.env, CLAUDE_CONFIG_DIR: config.configDir },
    cwd: config.checkout,
    log: (message) => console.error(message),
  });
  process.exitCode = exitCodeFor(end);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
