import assert from 'node:assert/strict';
import test from 'node:test';

import { answerAskUserQuestion } from './permission.mjs';

test('answers AskUserQuestion with the deterministic spike response', () => {
  assert.deepEqual(
    answerAskUserQuestion({
      name: 'AskUserQuestion',
      input: {
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
      },
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
});

test('refuses a tool other than AskUserQuestion', () => {
  assert.throws(
    () => answerAskUserQuestion({ name: 'Bash', input: { command: 'pwd' } }),
    /Expected AskUserQuestion, received Bash/,
  );
});
