import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import { AgentCredentialsPage, AgentTypesList } from './agent-credentials';
import {
  CredentialRequestError,
  type AgentCredentialDelivery,
  AgentCredentialSettings,
  CredentialClient,
} from './credentials';

afterEach(cleanup);

function settings(
  overrides: Partial<AgentCredentialSettings> = {},
): AgentCredentialSettings {
  return {
    agentType: 'producer',
    available: ['Deploy key', 'Registry token'],
    entries: [
      {
        builtIn: true,
        credentialName: 'Claude sign-in token',
        delivery: 'environment',
        destination: 'CLAUDE_CODE_OAUTH_TOKEN',
        needsAttention: false,
      },
      {
        builtIn: false,
        credentialName: 'Deploy key',
        delivery: 'file',
        destination: '/run/secrets/deploy',
        needsAttention: false,
      },
    ],
    ...overrides,
  };
}

function client(overrides: Partial<CredentialClient> = {}): CredentialClient {
  return {
    agentCredentials: async () => settings(),
    overview: async () => ({
      attention: [],
      instanceCredentials: [],
      project: null,
      projectCredentials: [],
    }),
    remove: async () => undefined,
    save: async ({ name }) => ({ name, replaced: false }),
    setAgentCredentials: async (_projectId, agentType, deliveries) => ({
      agentType,
      available: [],
      entries: deliveries.map((delivery) => ({
        ...delivery,
        builtIn: false,
        needsAttention: false,
      })),
    }),
    ...overrides,
  };
}

test('lists every agent type with a way to edit it', () => {
  render(<AgentTypesList />);

  const producer = screen.getByRole('link', { name: 'Edit Producer' });
  expect(producer.getAttribute('href')).toBe('#/settings/agents/producer');
  expect(screen.getByRole('link', { name: 'Edit Reviewer' })).toBeTruthy();
});

test('lists what an agent may use by name, delivery and destination', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client()}
      projectId="p1"
    />,
  );

  expect(
    screen.getByRole('heading', { level: 1, name: 'Edit Producer' }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Set what every producer may use when it works on this project.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole('link', { name: '← Agent types' }).getAttribute('href'),
  ).toBe('#/settings/agents');
  expect(
    screen.getByRole('heading', { name: 'Credentials this agent may use' }),
  ).toBeTruthy();
  expect(
    screen.getByText('Each saved credential is listed by name only.'),
  ).toBeTruthy();

  const builtIn = await screen.findByRole('listitem', {
    name: 'Claude sign-in token',
  });
  expect(
    within(builtIn).getByText('Environment variable · CLAUDE_CODE_OAUTH_TOKEN'),
  ).toBeTruthy();
  expect(within(builtIn).getByText('Always given')).toBeTruthy();
  expect(within(builtIn).queryByRole('button')).toBeNull();

  const declared = screen.getByRole('listitem', { name: 'Deploy key' });
  expect(within(declared).getByText('File · /run/secrets/deploy')).toBeTruthy();
  expect(
    within(declared).getByRole('button', { name: 'Change Deploy key' }),
  ).toBeTruthy();
});

test('marks a credential that needs attention and the agent that cannot start', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client({
        agentCredentials: async () =>
          settings({
            entries: [
              {
                builtIn: false,
                credentialName: 'Deploy key',
                delivery: 'environment',
                destination: 'DEPLOY_KEY',
                needsAttention: true,
              },
            ],
          }),
      })}
      projectId="p1"
    />,
  );

  const entry = await screen.findByRole('listitem', { name: 'Deploy key' });
  expect(
    within(entry).getByText('This project’s credential needs attention'),
  ).toBeTruthy();
  expect(within(entry).getByText('Cannot start')).toBeTruthy();
});

test('gives the agent a credential through the dialog, then saves the changes', async () => {
  const saved: AgentCredentialDelivery[][] = [];
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client({
        setAgentCredentials: async (_projectId, agentType, deliveries) => {
          saved.push([...deliveries]);
          return settings({
            entries: deliveries.map((delivery) => ({
              ...delivery,
              builtIn: false,
              needsAttention: false,
            })),
          });
        },
      })}
      projectId="p1"
    />,
  );
  await screen.findByRole('listitem', { name: 'Deploy key' });
  const save = screen.getByRole('button', { name: 'Save changes' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  const add = screen.getByRole('button', { name: 'Add credential' });

  await userEvent.click(add);

  const dialog = screen.getByRole('dialog', {
    name: 'Give this agent a credential',
  });
  expect(
    within(dialog).getByText(
      'Choose the saved credential and how the agent receives it. Its value stays hidden.',
    ),
  ).toBeTruthy();
  expect(document.activeElement).toBe(
    within(dialog).getByLabelText('Credential'),
  );
  expect(
    within(dialog).getByText(
      'The agent receives this value under a variable name.',
    ),
  ).toBeTruthy();
  expect(
    within(dialog).getByText(
      'The agent receives a temporary file at a path you name.',
    ),
  ).toBeTruthy();

  await userEvent.selectOptions(
    within(dialog).getByLabelText('Credential'),
    'Registry token',
  );
  await userEvent.click(
    within(dialog).getByRole('radio', { name: 'Environment variable' }),
  );
  await userEvent.type(
    within(dialog).getByLabelText('Variable name'),
    'REGISTRY_TOKEN',
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add credential' }),
  );

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(add);
  expect(
    within(screen.getByRole('listitem', { name: 'Registry token' })).getByText(
      'Environment variable · REGISTRY_TOKEN',
    ),
  ).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() =>
    expect(saved).toEqual([
      [
        {
          credentialName: 'Deploy key',
          delivery: 'file',
          destination: '/run/secrets/deploy',
        },
        {
          credentialName: 'Registry token',
          delivery: 'environment',
          destination: 'REGISTRY_TOKEN',
        },
      ],
    ]),
  );
});

test('keeps the dialog open and marks a destination already in use', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client()}
      projectId="p1"
    />,
  );
  await screen.findByRole('listitem', { name: 'Deploy key' });

  await userEvent.click(screen.getByRole('button', { name: 'Add credential' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.click(
    within(dialog).getByRole('radio', { name: 'Environment variable' }),
  );
  const destination = within(dialog).getByLabelText('Variable name');
  await userEvent.type(destination, 'CLAUDE_CODE_OAUTH_TOKEN');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add credential' }),
  );

  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(destination.getAttribute('aria-invalid')).toBe('true');
  expect(
    within(dialog).getByText(
      '“CLAUDE_CODE_OAUTH_TOKEN” is already used. Choose a different name or change the existing credential.',
    ),
  ).toBeTruthy();

  await userEvent.clear(destination);
  await userEvent.type(destination, 'not a name');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add credential' }),
  );
  expect(
    within(dialog).getByText(
      'Use letters, numbers and underscores, starting with a letter.',
    ),
  ).toBeTruthy();

  await userEvent.click(within(dialog).getByRole('radio', { name: 'File' }));
  const path = within(dialog).getByLabelText('File path');
  await userEvent.clear(path);
  await userEvent.type(path, '/work/secret');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add credential' }),
  );
  expect(
    within(dialog).getByText(
      'Use a full path outside /work, such as /run/secrets/token.',
    ),
  ).toBeTruthy();
});

test('closes the dialog on Escape, Cancel or close, returning focus', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client()}
      projectId="p1"
    />,
  );
  const change = await screen.findByRole('button', {
    name: 'Change Deploy key',
  });

  for (const close of [
    () => userEvent.keyboard('{Escape}'),
    () =>
      userEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Cancel',
        }),
      ),
    () => userEvent.click(screen.getByRole('button', { name: 'Close' })),
  ]) {
    await userEvent.click(change);
    expect(
      screen.getByRole('dialog', { name: 'Give this agent a credential' }),
    ).toBeTruthy();
    await close();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(change);
  }
  expect(
    (screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test('changes or removes a credential, and cancels unsaved changes', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client()}
      projectId="p1"
    />,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Change Deploy key' }),
  );
  const dialog = screen.getByRole('dialog');
  expect(
    (within(dialog).getByLabelText('File path') as HTMLInputElement).value,
  ).toBe('/run/secrets/deploy');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Remove from this agent' }),
  );

  expect(screen.queryByRole('listitem', { name: 'Deploy key' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.getByRole('listitem', { name: 'Deploy key' })).toBeTruthy();
});

test('keeps the choices when saving fails, and tries again', async () => {
  let calls = 0;
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client({
        setAgentCredentials: async (_projectId, agentType, deliveries) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('down');
          }
          return settings({
            entries: deliveries.map((delivery) => ({
              ...delivery,
              builtIn: false,
              needsAttention: false,
            })),
          });
        },
      })}
      projectId="p1"
    />,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Change Deploy key' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Remove from this agent' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(
    await screen.findByText(
      'Couldn’t save these credentials. Your choices are still here.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('listitem', { name: 'Deploy key' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

  await waitFor(() => expect(calls).toBe(2));
  expect(
    screen.queryByText(
      'Couldn’t save these credentials. Your choices are still here.',
    ),
  ).toBeNull();
});

test('explains a failed read rather than listing nothing', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client({
        agentCredentials: async () => {
          throw new Error('down');
        },
      })}
      projectId="p1"
    />,
  );

  expect(
    await screen.findByText(
      'Cerebra couldn’t load credentials. Nothing has been changed. Try again.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
});

test('treats any casing of the reserved prefix as already used', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client()}
      projectId="p1"
    />,
  );
  await screen.findByRole('listitem', { name: 'Deploy key' });
  await userEvent.click(screen.getByRole('button', { name: 'Add credential' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.type(
    within(dialog).getByLabelText('Variable name'),
    'cerebra_token',
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add credential' }),
  );

  expect(
    within(dialog).getByText(
      '“cerebra_token” is already used. Choose a different name or change the existing credential.',
    ),
  ).toBeTruthy();
});

test('names a destination the server finds already used', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client({
        setAgentCredentials: async () => {
          throw new CredentialRequestError(
            'refused',
            'duplicate_destination',
            'DEPLOY_KEY',
          );
        },
      })}
      projectId="p1"
    />,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Change Deploy key' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Remove from this agent' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(
    await screen.findByText(
      '“DEPLOY_KEY” is already used. Choose a different name or change the existing credential.',
    ),
  ).toBeTruthy();
});

test('offers the agreed actions when changing a credential', async () => {
  render(
    <AgentCredentialsPage
      agentType="producer"
      client={client()}
      projectId="p1"
    />,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Change Deploy key' }),
  );
  const dialog = screen.getByRole('dialog');

  expect(
    within(dialog).getByRole('button', { name: 'Add credential' }),
  ).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: /Update/ })).toBeNull();
});
