import assert from 'node:assert/strict';
import test from 'node:test';

import { createAskUserQuestionOptions } from './runner.mjs';

test('registers AskUserQuestion as the only tool and returns the deterministic answer', async () => {
  let receivedQuestion = false;
  const options = createAskUserQuestionOptions(() => {
    receivedQuestion = true;
  });

  assert.deepEqual(options.tools, ['AskUserQuestion']);
  assert.deepEqual(
    await options.canUseTool('AskUserQuestion', {
      questions: [
        {
          question: 'Should the spike continue?',
          header: 'Spike',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Stop' },
          ],
        },
      ],
    }),
    {
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            question: 'Should the spike continue?',
            header: 'Spike',
            options: [
              { label: 'Yes', description: 'Continue' },
              { label: 'No', description: 'Stop' },
            ],
            answer: 'Continue the OAuth-only rootless Podman spike.',
          },
        ],
      },
    },
  );
  assert.equal(receivedQuestion, true);
});

test('the query callback refuses a tool other than AskUserQuestion', async () => {
  const { canUseTool } = createAskUserQuestionOptions(() => {});

  await assert.rejects(
    canUseTool('Bash', { command: 'pwd' }),
    /Expected AskUserQuestion, received Bash/,
  );
});
