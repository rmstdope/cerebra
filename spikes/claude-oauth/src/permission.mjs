export const spikeAnswer = 'Continue the OAuth-only rootless Podman spike.';

export function answerAskUserQuestion({ name, input }) {
  if (name !== 'AskUserQuestion') {
    throw new Error(`Expected AskUserQuestion, received ${name}`);
  }

  if (!Array.isArray(input.questions)) {
    throw new Error('AskUserQuestion did not include questions.');
  }

  return {
    behavior: 'allow',
    updatedInput: {
      ...input,
      questions: input.questions.map((question) => ({
        ...question,
        answer: spikeAnswer,
      })),
    },
  };
}
