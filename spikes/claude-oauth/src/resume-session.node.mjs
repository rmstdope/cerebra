import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESUME_CONTEXT_TOKEN,
  runInitialSession,
  runResumedSession,
} from './resume-session.mjs';

const sessionId = 'session-from-initial-container';

function messages(...items) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

test('persists the initial SDK session ID and resumes it in a replacement query', async () => {
  const calls = [];
  const markers = [];
  let persistedSessionId;
  const createQuery = (arguments_) => {
    calls.push(arguments_);

    if (calls.length === 1) {
      return messages(
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', session_id: sessionId },
      );
    }

    return messages(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: RESUME_CONTEXT_TOKEN }] },
      },
      { type: 'result', subtype: 'success', session_id: sessionId },
    );
  };

  await runInitialSession({
    createQuery,
    persistSessionId: async (value) => {
      persistedSessionId = value;
    },
    write: (marker) => markers.push(marker),
  });
  await runResumedSession({
    createQuery,
    sessionId: persistedSessionId,
    write: (marker) => markers.push(marker),
  });

  assert.equal(persistedSessionId, sessionId);
  assert.equal(calls[1].options.resume, sessionId);
  assert.deepEqual(markers, [
    'INITIAL_SESSION_COMPLETE',
    'SESSION_RESUMED',
    'SPIKE_COMPLETE',
  ]);
});

test('refuses an initial result without a session ID', async () => {
  await assert.rejects(
    runInitialSession({
      createQuery: () => messages({ type: 'result', subtype: 'success' }),
      persistSessionId: async () => {},
      write: () => {},
    }),
    /did not provide a session ID/,
  );
});

test('refuses a resumed result without the prior context token', async () => {
  await assert.rejects(
    runResumedSession({
      createQuery: () =>
        messages(
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'wrong token' }] },
          },
          { type: 'result', subtype: 'success', session_id: sessionId },
        ),
      sessionId,
      write: () => {},
    }),
    /did not acknowledge the prior conversation context/,
  );
});

test('refuses an unsuccessful resumed query even after the context token', async () => {
  await assert.rejects(
    runResumedSession({
      createQuery: () =>
        messages(
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: RESUME_CONTEXT_TOKEN }],
            },
          },
          { type: 'result', subtype: 'error', session_id: sessionId },
        ),
      sessionId,
      write: () => {},
    }),
    /did not complete the resumed session/,
  );
});
