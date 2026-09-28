export async function answerAskUserQuestion({ name, input, relayUrl }) {
  if (name !== 'AskUserQuestion') {
    throw new Error(`Expected AskUserQuestion, received ${name}`);
  }

  if (!Array.isArray(input.questions)) {
    throw new Error('AskUserQuestion did not include questions.');
  }

  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questions: input.questions }),
  });
  if (!response.ok) {
    throw new Error(`Question relay returned ${response.status}.`);
  }

  const { answer } = await response.json();
  if (typeof answer !== 'string' || answer === '') {
    throw new Error('Question relay did not return an answer.');
  }

  return {
    behavior: 'allow',
    updatedInput: {
      ...input,
      questions: input.questions.map((question) => ({
        ...question,
        answer,
      })),
    },
  };
}
