import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import type {
  CredentialClient,
  CredentialOverview,
  CredentialRow,
} from './credentials';
import { CredentialsPage } from './credentials-page';

afterEach(cleanup);

function memoryStorage(
  initial: Record<string, string> = {},
): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    values,
  };
}

function row(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: 'c1',
    lastUsedAt: null,
    lastUsedRunId: null,
    name: 'Deploy key',
    needsAttention: false,
    scope: 'project',
    usedBy: [],
    usedByEveryAgent: false,
    ...overrides,
  };
}

function overview(
  overrides: Partial<CredentialOverview> = {},
): CredentialOverview {
  return {
    attention: [],
    instanceCredentials: [],
    project: { id: 'p1', name: 'acme/app' },
    projectCredentials: [],
    ...overrides,
  };
}

function client(overrides: Partial<CredentialClient> = {}): CredentialClient {
  return {
    agentCredentials: async (_projectId, agentType) => ({
      agentType,
      available: [],
      entries: [],
    }),
    overview: async () => overview(),
    remove: async () => undefined,
    save: async ({ name }) => ({ name, replaced: false }),
    setAgentCredentials: async (_projectId, agentType) => ({
      agentType,
      available: [],
      entries: [],
    }),
    ...overrides,
  };
}

test('shows both scopes of a credential with where it applies and what uses it', async () => {
  const today = new Date().toISOString();
  render(
    <CredentialsPage
      client={client({
        overview: async () =>
          overview({
            instanceCredentials: [
              row({
                id: 'c2',
                name: 'Claude sign-in token',
                scope: 'instance',
                usedByEveryAgent: true,
              }),
              row({
                id: 'c3',
                lastUsedAt: '2026-01-05T10:00:00.000Z',
                name: 'Deploy key',
                scope: 'instance',
              }),
            ],
            projectCredentials: [
              row({ lastUsedAt: today, usedBy: ['producer', 'bugfixer'] }),
            ],
          }),
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );

  expect(
    screen.getByRole('heading', { level: 1, name: 'Credentials' }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Add credentials once, then review only where they apply and when they were last used.',
    ),
  ).toBeTruthy();
  expect(
    screen
      .getByRole('tab', { name: 'This project' })
      .getAttribute('aria-selected'),
  ).toBe('true');
  expect(
    screen.getByText(
      'Project credentials take priority. A credential here is used before one with the same name saved for every project.',
    ),
  ).toBeTruthy();

  const projectRow = await screen.findByRole('listitem', {
    name: 'Deploy key, Project credential',
  });
  expect(within(projectRow).getByText('Producers, Bugfixers')).toBeTruthy();
  expect(within(projectRow).getByText('Used today')).toBeTruthy();
  expect(
    within(projectRow).getByRole('button', { name: 'Manage Deploy key' }),
  ).toBeTruthy();

  await userEvent.click(screen.getByRole('tab', { name: 'Every project' }));

  const tokenRow = screen.getByRole('listitem', {
    name: 'Claude sign-in token, Every-project credential',
  });
  expect(within(tokenRow).getByText('Every Claude agent')).toBeTruthy();
  expect(within(tokenRow).getByText('Never')).toBeTruthy();
  const instanceRow = screen.getByRole('listitem', {
    name: 'Deploy key, Every-project credential',
  });
  expect(within(instanceRow).getByText('Not used yet')).toBeTruthy();
  expect(within(instanceRow).getByText(/^Used on /)).toBeTruthy();
});

test('remembers the chosen tab, and offers only every project without a project', async () => {
  const storage = memoryStorage();
  const credentials = client();
  const { unmount } = render(
    <CredentialsPage client={credentials} projectId="p1" storage={storage} />,
  );
  await userEvent.click(screen.getByRole('tab', { name: 'Every project' }));
  unmount();

  render(
    <CredentialsPage client={credentials} projectId="p1" storage={storage} />,
  );
  expect(
    screen
      .getByRole('tab', { name: 'Every project' })
      .getAttribute('aria-selected'),
  ).toBe('true');
  cleanup();

  render(
    <CredentialsPage
      client={client({
        overview: async () => overview({ project: null }),
      })}
      projectId={null}
      storage={memoryStorage({ 'cerebra.credentials.tab': 'project' })}
    />,
  );
  expect(screen.queryByRole('tab', { name: 'This project' })).toBeNull();
  expect(
    screen
      .getByRole('tab', { name: 'Every project' })
      .getAttribute('aria-selected'),
  ).toBe('true');
});

test('says a scope is empty only once it has loaded', async () => {
  let resolve: (value: CredentialOverview) => void = () => undefined;
  render(
    <CredentialsPage
      client={client({
        overview: () =>
          new Promise((done) => {
            resolve = done;
          }),
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );

  expect(screen.getAllByTestId('credential-placeholder').length).toBe(3);
  expect(
    screen.queryByText('No credentials saved for this project'),
  ).toBeNull();

  await act(async () => resolve(overview()));

  expect(
    screen.getByText('No credentials saved for this project'),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Project credentials can override an every-project credential with the same name.',
    ),
  ).toBeTruthy();
  expect(screen.queryAllByTestId('credential-placeholder')).toHaveLength(0);
  expect(screen.getAllByRole('button', { name: 'Add credential' }).length).toBe(
    2,
  );
});

test('explains a failed read and tries again', async () => {
  let calls = 0;
  render(
    <CredentialsPage
      client={client({
        overview: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error('down');
          }
          return overview({ projectCredentials: [row()] });
        },
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );

  expect(
    await screen.findByText(
      'Cerebra couldn’t load credentials. Nothing has been changed. Try again.',
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText('No credentials saved for this project'),
  ).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(
    await screen.findByRole('listitem', {
      name: 'Deploy key, Project credential',
    }),
  ).toBeTruthy();
});

test('adds a credential from the side panel without showing its value again', async () => {
  const saved: unknown[] = [];
  let release: () => void = () => undefined;
  render(
    <CredentialsPage
      client={client({
        save: async (input) => {
          saved.push(input);
          await new Promise<void>((done) => {
            release = done;
          });
          return { name: input.name, replaced: false };
        },
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );
  await screen.findByText('No credentials saved for this project');
  const addButton = screen.getAllByRole('button', {
    name: 'Add credential',
  })[0];

  await userEvent.click(addButton);

  const panel = screen.getByRole('dialog', { name: 'Add a credential' });
  const name = within(panel).getByLabelText('Name');
  expect(document.activeElement).toBe(name);
  expect(
    within(panel).getByText('Use a clear name so you can recognise it later.'),
  ).toBeTruthy();
  expect(
    within(panel).getByText(
      'Paste the value. Cerebra never displays it after you save.',
    ),
  ).toBeTruthy();
  expect(
    within(panel).getByText(
      'Its value is saved securely and will not be shown again.',
    ),
  ).toBeTruthy();
  expect(
    within(panel).getByRole('radio', { name: 'This project — acme/app' }),
  ).toBeTruthy();
  const save = within(panel).getByRole('button', { name: 'Save credential' });
  expect((save as HTMLButtonElement).disabled).toBe(true);

  await userEvent.type(name, 'Deploy key');
  const value = within(panel).getByLabelText('Credential value');
  expect(value.getAttribute('type')).toBe('password');
  await userEvent.type(value, 'secret-value');
  await userEvent.click(save);

  const saving = within(panel).getByRole('button', {
    name: 'Saving credential…',
  });
  expect((saving as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release());

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(addButton);
  expect(screen.getByRole('status').textContent).toBe('“Deploy key” saved.');
  expect(document.body.textContent).not.toContain('secret-value');
  expect(saved).toEqual([
    {
      name: 'Deploy key',
      projectId: 'p1',
      scope: 'project',
      value: 'secret-value',
    },
  ]);
});

test('discards an unsaved entry on Escape, Cancel, or close', async () => {
  render(
    <CredentialsPage
      client={client()}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );
  await screen.findByText('No credentials saved for this project');
  const addButton = screen.getAllByRole('button', {
    name: 'Add credential',
  })[0];

  for (const close of [
    () => userEvent.keyboard('{Escape}'),
    () => userEvent.click(screen.getByRole('button', { name: 'Cancel' })),
    () => userEvent.click(screen.getByRole('button', { name: 'Close' })),
  ]) {
    await userEvent.click(addButton);
    await userEvent.type(screen.getByLabelText('Name'), 'Draft');
    await close();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(addButton);
  }

  await userEvent.click(addButton);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
});

test('keeps the panel after a failed save, clearing and focusing the value', async () => {
  render(
    <CredentialsPage
      client={client({
        save: async () => {
          throw new Error('refused');
        },
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );
  await screen.findByText('No credentials saved for this project');
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Add credential' })[0],
  );
  await userEvent.type(screen.getByLabelText('Name'), 'Deploy key');
  await userEvent.click(screen.getByRole('radio', { name: 'Every project' }));
  await userEvent.type(screen.getByLabelText('Credential value'), 'bad');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save credential' }),
  );

  expect(
    await screen.findByText(
      'Couldn’t save “Deploy key”. It was not added. Check the value and try again.',
    ),
  ).toBeTruthy();
  const value = screen.getByLabelText('Credential value') as HTMLInputElement;
  expect(value.value).toBe('');
  expect(document.activeElement).toBe(value);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
    'Deploy key',
  );
  expect(
    (screen.getByRole('radio', { name: 'Every project' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test('warns before a matching name and scope replaces a value', async () => {
  const saved: unknown[] = [];
  render(
    <CredentialsPage
      client={client({
        overview: async () => overview({ projectCredentials: [row()] }),
        save: async (input) => {
          saved.push(input);
          return { name: input.name, replaced: true };
        },
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );
  const warning =
    'Replacing a credential: saving a matching name and scope replaces its existing value. Active work keeps the value it already received.';
  const manage = await screen.findByRole('button', {
    name: 'Manage Deploy key',
  });

  await userEvent.click(
    screen.getAllByRole('button', { name: 'Add credential' })[0],
  );
  expect(screen.queryByText(warning)).toBeNull();
  await userEvent.type(screen.getByLabelText('Name'), 'Deploy key');
  expect(screen.getByText(warning)).toBeTruthy();
  await userEvent.keyboard('{Escape}');

  await userEvent.click(manage);
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Replace credential' }),
  );

  const panel = screen.getByRole('dialog', { name: 'Replace a credential' });
  expect((within(panel).getByLabelText('Name') as HTMLInputElement).value).toBe(
    'Deploy key',
  );
  expect(
    (
      within(panel).getByRole('radio', {
        name: 'This project — acme/app',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (within(panel).getByLabelText('Credential value') as HTMLInputElement)
      .value,
  ).toBe('');
  expect(within(panel).getByText(warning)).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(panel).getByLabelText('Credential value'),
    ),
  );
  await userEvent.keyboard('{Escape}');
  expect(document.activeElement).toBe(manage);

  await userEvent.click(manage);
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Replace credential' }),
  );
  await userEvent.type(screen.getByLabelText('Credential value'), 'new');
  const panelAgain = screen.getByRole('dialog', {
    name: 'Replace a credential',
  });
  await userEvent.click(
    within(panelAgain).getByRole('button', { name: 'Save credential' }),
  );

  expect(await screen.findByText('“Deploy key” replaced.')).toBeTruthy();
  expect(saved).toEqual([
    { name: 'Deploy key', projectId: 'p1', scope: 'project', value: 'new' },
  ]);
});

test('confirms removal, and returns focus where the person was', async () => {
  const removed: string[] = [];
  let rows = [row(), row({ id: 'c4', name: 'Registry token' })];
  render(
    <CredentialsPage
      client={client({
        overview: async () => overview({ projectCredentials: rows }),
        remove: async (id) => {
          removed.push(id);
          rows = rows.filter((entry) => entry.id !== id);
        },
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );
  const manage = await screen.findByRole('button', {
    name: 'Manage Deploy key',
  });

  await userEvent.click(manage);
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Remove credential' }),
  );
  const confirm = screen.getByRole('alertdialog', {
    name: 'Remove “Deploy key”?',
  });
  expect(
    within(confirm).getByText(
      'It will no longer be available to new work. Work already under way keeps the value it received.',
    ),
  ).toBeTruthy();
  expect(
    within(confirm).getByText(
      'This cannot be undone. You can add a new credential with the same name later.',
    ),
  ).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(manage);

  await userEvent.click(manage);
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Remove credential' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Keep credential' }),
  );
  expect(document.activeElement).toBe(manage);
  expect(removed).toEqual([]);

  await userEvent.click(manage);
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Remove credential' }),
  );
  await userEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Remove credential',
    }),
  );

  expect(await screen.findByText('“Deploy key” removed.')).toBeTruthy();
  expect(removed).toEqual(['c1']);
  expect(
    screen.queryByRole('listitem', { name: 'Deploy key, Project credential' }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('listitem', {
      name: 'Registry token, Project credential',
    }),
  );
});

test('names each credential that needs attention and leads to it', async () => {
  render(
    <CredentialsPage
      client={client({
        overview: async () =>
          overview({
            attention: [
              {
                agentTypes: ['producer'],
                everyAgent: false,
                name: 'Deploy key',
                scope: 'project',
              },
            ],
            projectCredentials: [row({ needsAttention: true })],
          }),
      })}
      projectId="p1"
      storage={memoryStorage({ 'cerebra.credentials.tab': 'instance' })}
    />,
  );

  expect(await screen.findByText('1 credential needs attention')).toBeTruthy();
  expect(
    screen.getByText(
      'Producers cannot start until “Deploy key” is replaced or removed from their setup.',
    ),
  ).toBeTruthy();

  await userEvent.click(
    screen.getByRole('button', { name: 'View credential Deploy key' }),
  );

  const target = screen.getByRole('listitem', {
    name: 'Deploy key, Project credential',
  });
  expect(document.activeElement).toBe(target);
  expect(within(target).getByText('Needs attention')).toBeTruthy();
  expect(within(target).queryByText('Not used yet')).toBeNull();
});

test('counts several problems and names every one, including a missing one', async () => {
  render(
    <CredentialsPage
      client={client({
        overview: async () =>
          overview({
            attention: [
              {
                agentTypes: [],
                everyAgent: true,
                name: 'Claude sign-in token',
                scope: null,
              },
              {
                agentTypes: ['producer', 'bugfixer'],
                everyAgent: false,
                name: 'GitHub access token',
                scope: null,
              },
            ],
            instanceCredentials: [
              row({
                id: null,
                name: 'Claude sign-in token',
                needsAttention: true,
                scope: 'instance',
                usedByEveryAgent: true,
              }),
            ],
            projectCredentials: [
              row({
                id: null,
                name: 'GitHub access token',
                needsAttention: true,
                usedBy: ['producer', 'bugfixer'],
              }),
            ],
          }),
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );

  expect(await screen.findByText('2 credentials need attention')).toBeTruthy();
  expect(
    screen.getByText(
      'Agents cannot start until “Claude sign-in token” is replaced or removed from their setup.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Producers and Bugfixers cannot start until “GitHub access token” is replaced or removed from their setup.',
    ),
  ).toBeTruthy();

  await userEvent.click(
    screen.getByRole('button', { name: 'Manage GitHub access token' }),
  );
  expect(
    await screen.findByRole('menuitem', { name: 'Replace credential' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('menuitem', { name: 'Remove credential' }),
  ).toBeNull();
});

test('keeps focus on the control that opened the panel after saving', async () => {
  let rows: CredentialRow[] = [];
  render(
    <CredentialsPage
      client={client({
        overview: async () => overview({ projectCredentials: rows }),
        save: async ({ name }) => {
          rows = [row({ name })];
          return { name, replaced: rows.length > 0 };
        },
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );
  await screen.findByText('No credentials saved for this project');
  const [toolbarAdd, emptyAdd] = screen.getAllByRole('button', {
    name: 'Add credential',
  });

  await userEvent.click(emptyAdd);
  await userEvent.type(screen.getByLabelText('Name'), 'Deploy key');
  await userEvent.type(screen.getByLabelText('Credential value'), 'v1');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save credential' }),
  );

  const manage = await screen.findByRole('button', {
    name: 'Manage Deploy key',
  });
  await waitFor(() => expect(document.activeElement).toBe(toolbarAdd));

  await userEvent.click(manage);
  await userEvent.click(
    await screen.findByRole('menuitem', { name: 'Replace credential' }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByLabelText('Credential value'),
    ),
  );
  await userEvent.type(screen.getByLabelText('Credential value'), 'v2');
  await userEvent.click(
    screen.getByRole('button', { name: 'Save credential' }),
  );

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(manage));
});

test('names who cannot start even when no agent type uses the credential', async () => {
  render(
    <CredentialsPage
      client={client({
        overview: async () =>
          overview({
            attention: [
              {
                agentTypes: [],
                everyAgent: false,
                name: 'Old key',
                scope: 'instance',
              },
            ],
            instanceCredentials: [
              row({ name: 'Old key', needsAttention: true, scope: 'instance' }),
            ],
          }),
      })}
      projectId="p1"
      storage={memoryStorage()}
    />,
  );

  expect(
    await screen.findByText(
      'Agents cannot start until “Old key” is replaced or removed from their setup.',
    ),
  ).toBeTruthy();
});
