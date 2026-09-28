import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_MESSAGE_ACKNOWLEDGEMENT,
  runStreamInput,
} from './stream-input.mjs';

test('sends an external message after the SDK session is active and requires its acknowledgement', async () => {
  const markers = [];
  let streamedMessage;

  const query = {
    async streamInput(messages) {
      streamedMessage = (await messages[Symbol.asyncIterator]().next()).value;
    },
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init' };
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash' }],
        },
      };
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: EXTERNAL_MESSAGE_ACKNOWLEDGEMENT }],
        },
      };
      yield { type: 'result', subtype: 'success' };
    },
  };

  await runStreamInput({
    createQuery: () => query,
    write: (marker) => markers.push(marker),
  });

  assert.deepEqual(markers, [
    'STREAM_INPUT_READY',
    'EXTERNAL_MESSAGE_SENT',
    'EXTERNAL_MESSAGE_ACKNOWLEDGED',
    'SPIKE_COMPLETE',
  ]);
  assert.deepEqual(streamedMessage, {
    type: 'user',
    message: {
      role: 'user',
      content: 'The navigator says: STREAM_INPUT_DELIVERED',
    },
    parent_tool_use_id: null,
    session_id: '',
  });
});

test('fails when the active SDK session completes without acknowledging the external message', async () => {
  const query = {
    async streamInput() {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init' };
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash' }],
        },
      };
      yield { type: 'result', subtype: 'success' };
    },
  };

  await assert.rejects(
    runStreamInput({ createQuery: () => query, write: () => {} }),
    /did not acknowledge the external message/,
  );
});

test('fails when the SDK session completes before it starts its in-turn operation', async () => {
  const query = {
    async streamInput() {},
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init' };
      yield { type: 'result', subtype: 'success' };
    },
  };

  await assert.rejects(
    runStreamInput({ createQuery: () => query, write: () => {} }),
    /did not start its in-turn operation/,
  );
});
