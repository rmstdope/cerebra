import { query } from '@anthropic-ai/claude-agent-sdk';

import { createAskUserQuestionOptions } from './runner.mjs';

const prompt =
  'Call AskUserQuestion exactly once to ask whether the OAuth-only rootless Podman spike should continue. Do not use any other tool. After receiving the answer, reply with exactly SPIKE_COMPLETE.';

let receivedQuestion = false;
let completed = false;
const relayUrl =
  process.env.QUESTION_RELAY_URL ?? 'http://question-relay:8080/question';

for await (const message of query({
  prompt,
  options: {
    ...createAskUserQuestionOptions(relayUrl, () => {
      receivedQuestion = true;
      process.stdout.write('ASK_USER_QUESTION_RECEIVED\n');
    }),
  },
})) {
  if (message.type === 'result' && message.subtype === 'success') {
    completed = true;
  }
}

if (!receivedQuestion) {
  throw new Error('Claude did not call AskUserQuestion.');
}

if (!completed) {
  throw new Error('Claude did not complete the spike session.');
}

process.stdout.write('SPIKE_COMPLETE\n');
