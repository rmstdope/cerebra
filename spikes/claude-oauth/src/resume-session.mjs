import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RESUME_CONTEXT_TOKEN = 'RESUME_CONTEXT_CONFIRMED';

const initialPrompt =
  'Remember this exact response token for a later conversation: RESUME_CONTEXT_CONFIRMED. Reply with exactly INITIAL_SESSION_COMPLETE.';
const resumedPrompt =
  'Using the previous conversation only, reply with exactly the response token you were asked to remember.';

function sessionIdFrom(message) {
  return typeof message.session_id === 'string' && message.session_id !== ''
    ? message.session_id
    : undefined;
}

function assistantText(message) {
  if (
    message.type !== 'assistant' ||
    !Array.isArray(message.message?.content)
  ) {
    return '';
  }

  return message.message.content
    .filter(
      (content) => content.type === 'text' && typeof content.text === 'string',
    )
    .map((content) => content.text)
    .join('\n');
}

export async function runInitialSession({
  createQuery,
  persistSessionId,
  write,
}) {
  let sessionId;
  let completed = false;

  for await (const message of createQuery({
    prompt: initialPrompt,
    options: { allowedTools: [] },
  })) {
    sessionId ??= sessionIdFrom(message);
    completed ||= message.type === 'result' && message.subtype === 'success';
  }

  if (sessionId === undefined) {
    throw new Error(
      'Claude did not provide a session ID for the initial session.',
    );
  }
  if (!completed) {
    throw new Error('Claude did not complete the initial session.');
  }

  await persistSessionId(sessionId);
  write('INITIAL_SESSION_COMPLETE');
}

export async function runResumedSession({ createQuery, sessionId, write }) {
  let acknowledged = false;
  let completed = false;

  for await (const message of createQuery({
    prompt: resumedPrompt,
    options: { allowedTools: [], resume: sessionId },
  })) {
    acknowledged ||= assistantText(message).trim() === RESUME_CONTEXT_TOKEN;
    completed ||= message.type === 'result' && message.subtype === 'success';
  }

  if (!acknowledged) {
    throw new Error(
      'Claude did not acknowledge the prior conversation context.',
    );
  }
  if (!completed) {
    throw new Error('Claude did not complete the resumed session.');
  }

  write('SESSION_RESUMED');
  write('SPIKE_COMPLETE');
}

function sessionIdPath() {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? '/home/node/.claude';
  return path.join(configDirectory, 'cerebra-resume-session-id');
}

async function main() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const file = sessionIdPath();
  const write = (marker) => process.stdout.write(`${marker}\n`);

  if (process.env.CLAUDE_SPIKE_RESUME === 'true') {
    const sessionId = (await readFile(file, 'utf8')).trim();
    if (sessionId === '') {
      throw new Error('The persisted Claude session ID is empty.');
    }
    await runResumedSession({ createQuery: query, sessionId, write });
    return;
  }

  await runInitialSession({
    createQuery: query,
    persistSessionId: (sessionId) =>
      writeFile(file, sessionId, { mode: 0o600 }),
    write,
  });
}

if (import.meta.main) {
  await main();
}
