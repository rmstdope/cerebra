import assert from 'node:assert/strict';
import test from 'node:test';

import { createQuestionRelay, spikeAnswer } from './question-relay.mjs';
import { createAskUserQuestionOptions } from './runner.mjs';

const question = {
  question: 'Should the spike continue?',
  header: 'Spike',
  options: [
    { label: 'Yes', description: 'Continue' },
    { label: 'No', description: 'Stop' },
  ],
};

async function startRelay(onQuestion) {
  const server = createQuestionRelay(onQuestion);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/question`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test('registers AskUserQuestion as the only tool and relays its actual question', async (t) => {
  let receivedQuestion = false;
  let relayedQuestions;
  const relay = await startRelay((questions) => {
    relayedQuestions = questions;
  });
  t.after(() => relay.close());
  const options = createAskUserQuestionOptions(relay.url, () => {
    receivedQuestion = true;
  });

  assert.deepEqual(options.tools, ['AskUserQuestion']);
  assert.deepEqual(
    await options.canUseTool('AskUserQuestion', {
      questions: [question],
    }),
    {
      behavior: 'allow',
      updatedInput: {
        questions: [
          {
            ...question,
            answer: spikeAnswer,
          },
        ],
      },
    },
  );
  assert.deepEqual(relayedQuestions, [question]);
  assert.equal(receivedQuestion, true);
});

test('the query callback refuses a tool other than AskUserQuestion', async () => {
  const { canUseTool } = createAskUserQuestionOptions(
    'http://127.0.0.1:1/question',
    () => {},
  );

  await assert.rejects(
    canUseTool('Bash', { command: 'pwd' }),
    /Expected AskUserQuestion, received Bash/,
  );
});
