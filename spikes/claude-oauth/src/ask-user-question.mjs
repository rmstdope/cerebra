import { query } from '@anthropic-ai/claude-agent-sdk';

import { answerAskUserQuestion } from './permission.mjs';

const prompt =
  'Call AskUserQuestion exactly once to ask whether the OAuth-only rootless Podman spike should continue. Do not use any other tool. After receiving the answer, reply with exactly SPIKE_COMPLETE.';

let receivedQuestion = false;
let completed = false;

for await (const message of query({
  prompt,
  options: {
    tools: ['AskUserQuestion'],
    canUseTool: async (name, input) => {
      const answer = answerAskUserQuestion({ name, input });
      receivedQuestion = true;
      process.stdout.write('ASK_USER_QUESTION_RECEIVED\n');
      return answer;
    },
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
