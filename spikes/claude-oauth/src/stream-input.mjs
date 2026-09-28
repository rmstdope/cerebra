export const EXTERNAL_MESSAGE_ACKNOWLEDGEMENT = 'EXTERNAL_MESSAGE_ACKNOWLEDGED';

const externalMessage = 'The navigator says: STREAM_INPUT_DELIVERED';
const prompt =
  'Run `sleep 10` using Bash. While it runs, wait for a follow-up navigator message. After receiving it, reply with exactly EXTERNAL_MESSAGE_ACKNOWLEDGED.';

function createUserMessage(content) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

async function* oneMessage(message) {
  yield message;
}

function assistantText(message) {
  if (
    message.type !== 'assistant' ||
    !Array.isArray(message.message?.content)
  ) {
    return '';
  }

  return message.message.content
    .filter(
      (content) => content.type === 'text' && typeof content.text === 'string',
    )
    .map((content) => content.text)
    .join('\n');
}

function startedInTurnOperation(message) {
  return (
    message.type === 'assistant' &&
    Array.isArray(message.message?.content) &&
    message.message.content.some(
      (content) => content.type === 'tool_use' && content.name === 'Bash',
    )
  );
}

export async function runStreamInput({ createQuery, write }) {
  const query = createQuery({
    prompt,
    options: {
      allowedTools: ['Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 2,
    },
  });
  let sent = false;
  let inTurnOperationStarted = false;
  let acknowledged = false;
  let completed = false;

  for await (const message of query) {
    if (startedInTurnOperation(message) && !sent) {
      inTurnOperationStarted = true;
      write('STREAM_INPUT_READY');
      await query.streamInput(oneMessage(createUserMessage(externalMessage)));
      write('EXTERNAL_MESSAGE_SENT');
      sent = true;
    }

    if (assistantText(message).includes(EXTERNAL_MESSAGE_ACKNOWLEDGEMENT)) {
      write(EXTERNAL_MESSAGE_ACKNOWLEDGEMENT);
      acknowledged = true;
    }

    if (message.type === 'result' && message.subtype === 'success') {
      completed = true;
    }
  }

  if (!sent) {
    if (!inTurnOperationStarted) {
      throw new Error('Claude did not start its in-turn operation.');
    }

    throw new Error('Claude did not start the streaming-input session.');
  }

  if (!acknowledged) {
    throw new Error('Claude did not acknowledge the external message.');
  }

  if (!completed) {
    throw new Error('Claude did not complete the streaming-input session.');
  }

  write('SPIKE_COMPLETE');
}

async function main() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  await runStreamInput({
    createQuery: query,
    write: (marker) => process.stdout.write(`${marker}\n`),
  });
}

if (import.meta.main) {
  await main();
}
