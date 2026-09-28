import { answerAskUserQuestion } from './permission.mjs';

export function createAskUserQuestionOptions(relayUrl, onQuestion) {
  return {
    tools: ['AskUserQuestion'],
    canUseTool: async (name, input) => {
      const answer = await answerAskUserQuestion({ name, input, relayUrl });
      onQuestion();
      return answer;
    },
  };
}
