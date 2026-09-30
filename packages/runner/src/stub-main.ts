import { exitCodeFor, readRunnerConfig } from './runner-config.js';
import { runRunnerSession } from './session.js';
import { createStubQuery } from './stub-query.js';

// The stub agent image's entry: the real runner, with a script in place of Claude (architecture
// §13). Whatever it writes stays removable by the backend, which in tests is not uid 1000.
process.umask(0);

try {
  const config = readRunnerConfig(process.env);
  const end = await runRunnerSession({
    ...config,
    query: createStubQuery(),
    env: process.env,
    cwd: config.checkout,
    log: (message) => console.error(message),
  });
  process.exitCode = exitCodeFor(end);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
