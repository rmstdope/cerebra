import { answerAskUserQuestion } from './permission.mjs';

export function createAskUserQuestionOptions(onQuestion) {
  return {
    tools: ['AskUserQuestion'],
    canUseTool: async (name, input) => {
      const answer = answerAskUserQuestion({ name, input });
      onQuestion();
      return answer;
    },
  };
}
