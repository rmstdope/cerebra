import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import {
  FleetRequestError,
  type FleetClient,
  type FleetPerson,
  type FleetRole,
  type FleetView,
} from './fleet';
import { FleetPage } from './fleet-page';

afterEach(cleanup);

function person(
  name: string,
  role: FleetPerson['role'],
  extra: Partial<FleetPerson> = {},
): FleetPerson {
  return {
    activity: { kind: 'available' },
    enabled: true,
    id: `agent-${name.toLowerCase()}`,
    name,
    role,
    running:
      extra.activity !== undefined && extra.activity.kind !== 'available',
    typeId: `type-${role}`,
    ...extra,
  };
}

function role(
  name: FleetRole['role'],
  people: readonly string[],
  extra: Partial<FleetRole> = {},
): FleetRole {
  return {
    interactive: name === 'assistant',
    model: 'opus',
    people,
    role: name,
    startMode: name === 'assistant' ? null : 'ready',
    typeId: `type-${name}`,
    ...extra,
  };
}

const project = { id: 'project-1', name: 'admin', owner: 'northstar' };

const fleet: FleetView = {
  people: [
    person('Astra', 'assistant'),
    person('Storm', 'producer', {
      activity: {
        item: { id: 'item-1', title: 'Make reports easier to share' },
        kind: 'waiting',
        question: 'Storm asked which export format to support first.',
      },
    }),
    person('Magma', 'producer', {
      activity: {
        item: { id: 'item-2', title: 'Make sign-in clearer' },
        kind: 'working',
      },
    }),
    person('Cleo', 'designer'),
    person('Bishop', 'bugfixer', { enabled: false }),
  ],
  project,
  roles: [
    role('assistant', ['Astra']),
    role('groomer', []),
    role('designer', ['Cleo'], { startMode: 'manual' }),
    role('producer', ['Storm', 'Magma']),
    role('bugfixer', ['Bishop']),
    role('reviewer', []),
  ],
};

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function createClient(overrides: Partial<FleetClient> = {}): FleetClient {
  return {
    addPerson: async (_projectId, input) =>
      person(input.name, 'producer', { id: 'agent-new' }),
    read: async () => fleet,
    removePerson: async () => undefined,
    saveRoleSettings: async (_projectId, typeId, settings) => ({
      ...role('producer', ['Storm', 'Magma']),
      ...settings,
      typeId,
    }),
    start: async () => undefined,
    stop: async () => undefined,
    updatePerson: async (agentId, changes) => ({
      ...(fleet.people.find((entry) => entry.id === agentId) ??
        person('Nobody', 'producer')),
      ...changes,
    }),
    ...overrides,
  };
}

function renderFleet(
  client: FleetClient = createClient(),
  extra: Partial<Parameters<typeof FleetPage>[0]> = {},
) {
  return render(
    <FleetPage
      client={client}
      projectId="project-1"
      storage={memoryStorage()}
      {...extra}
    />,
  );
}

function card(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

test('shows every person in stable order with the agreed words for their state', async () => {
  renderFleet();

  expect(
    screen.getByRole('heading', { level: 2, name: 'Your fleet' }),
  ).toBeTruthy();
  expect(
    await screen.findByText(
      'The people working on northstar/admin. Start a conversation or see what each one is doing.',
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'People in this fleet' }))
      .getAllByRole('article')
      .map((article) => article.getAttribute('aria-label')),
  ).toEqual(['Astra', 'Storm', 'Magma', 'Cleo', 'Bishop']);

  const astra = within(card('Astra'));
  expect(astra.getByText('Assistant')).toBeTruthy();
  expect(astra.getByText('Ready to talk')).toBeTruthy();
  expect(astra.getByText('Start a conversation')).toBeTruthy();
  expect(
    astra.getByText('Ask about this project, file work, or request a release.'),
  ).toBeTruthy();
  expect(astra.getByRole('button', { name: 'Open chat' })).toBeTruthy();

  const storm = within(card('Storm'));
  expect(storm.getByText('Waiting for your answer')).toBeTruthy();
  expect(storm.getByText('Make reports easier to share')).toBeTruthy();
  expect(
    storm.getByText('Storm asked which export format to support first.'),
  ).toBeTruthy();
  expect(storm.getByRole('button', { name: 'Open chat' })).toBeTruthy();
  expect(storm.getByRole('button', { name: 'View work' })).toBeTruthy();
  expect(storm.getByRole('button', { name: 'Stop' })).toBeTruthy();

  const magma = within(card('Magma'));
  expect(magma.getByText('Working now')).toBeTruthy();
  expect(magma.getByText('Make sign-in clearer')).toBeTruthy();
  expect(magma.getByRole('button', { name: 'View work' })).toBeTruthy();
  expect(magma.getByRole('button', { name: 'Stop' })).toBeTruthy();

  const cleo = within(card('Cleo'));
  expect(cleo.getByText('Designer')).toBeTruthy();
  expect(cleo.getByText('Available')).toBeTruthy();
  expect(cleo.getByText('No work in hand')).toBeTruthy();
  expect(cleo.getByText('Available when needed')).toBeTruthy();
  expect(cleo.getByRole('button', { name: 'Start' })).toBeTruthy();

  const bishop = within(card('Bishop'));
  expect(bishop.getByText('Bug fixer')).toBeTruthy();
  expect(bishop.getByText('Disabled')).toBeTruthy();
  expect(bishop.getByText('Won’t start until you enable Bishop.')).toBeTruthy();
  expect(bishop.queryByRole('button', { name: 'Start' })).toBeNull();

  expect(screen.getByText('1 agent needs you.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: /People/ }).textContent).toContain(
    '5',
  );
});

test('an available person whose role starts from work shows only the agreed words', async () => {
  renderFleet(
    createClient({
      read: async () => ({
        ...fleet,
        people: [person('Emma', 'reviewer')],
      }),
    }),
  );

  const emma = await screen.findByRole('article', { name: 'Emma' });
  expect(within(emma).getByText('Available')).toBeTruthy();
  expect(within(emma).getByText('No work in hand')).toBeTruthy();
  expect(emma.textContent).not.toContain('Starts when');
});

test('a person running without held work offers Stop, not Start, and cannot be removed', async () => {
  renderFleet(
    createClient({
      read: async () => ({
        ...fleet,
        people: [person('Emma', 'reviewer', { running: true })],
      }),
    }),
  );

  const emma = within(await screen.findByRole('article', { name: 'Emma' }));
  expect(emma.getByText('Working now')).toBeTruthy();
  expect(emma.queryByRole('button', { name: 'Start' })).toBeNull();
  expect(emma.getByRole('button', { name: 'Stop' })).toBeTruthy();

  await userEvent.click(emma.getByRole('button', { name: /More actions/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Stop this work before removing Emma.')).toBeTruthy();
});

test('Open chat on a running assistant opens its conversation without starting another run', async () => {
  const started: string[] = [];
  const opened: string[] = [];
  renderFleet(
    createClient({
      read: async () => ({
        ...fleet,
        people: [person('Astra', 'assistant', { running: true })],
      }),
      start: async (agentId) => void started.push(agentId),
    }),
    { onOpenChat: (entry) => opened.push(entry.id) },
  );

  const astra = within(await screen.findByRole('article', { name: 'Astra' }));
  expect(astra.getByText('Ready to talk')).toBeTruthy();
  await userEvent.click(astra.getByRole('button', { name: 'Open chat' }));
  expect(started).toEqual([]);
  expect(opened).toEqual(['agent-astra']);
});

test('several waiting people are counted and Open chat opens the first of them', async () => {
  const started: string[] = [];
  const opened: string[] = [];
  const waiting = (name: string) =>
    person(name, 'producer', {
      activity: {
        item: { id: `item-${name}`, title: `Work for ${name}` },
        kind: 'waiting',
        question: `${name} has a question.`,
      },
    });
  renderFleet(
    createClient({
      read: async () => ({
        ...fleet,
        people: [waiting('Storm'), waiting('Rogue')],
      }),
      start: async (agentId) => void started.push(agentId),
    }),
    { onOpenChat: (entry) => opened.push(entry.id) },
  );
  const notice = await screen.findByRole('status');

  expect(notice.textContent).toContain('2 agents need you.');
  await userEvent.click(
    within(notice).getByRole('button', { name: 'Open chat' }),
  );
  expect(started).toEqual([]);
  expect(opened).toEqual(['agent-storm']);
  expect(notice.textContent).not.toContain('is waiting for an answer');
});

test('loading keeps the heading and shows six placeholders', () => {
  renderFleet(createClient({ read: () => new Promise(() => undefined) }));

  expect(
    screen.getByRole('heading', { level: 2, name: 'Your fleet' }),
  ).toBeTruthy();
  expect(screen.getAllByTestId('person-placeholder')).toHaveLength(6);
  expect(screen.queryByText('No people in this fleet yet')).toBeNull();
});

test('a failed refresh keeps the last fleet and offers Try again', async () => {
  let fail = false;
  const client = createClient({
    read: async () => {
      if (fail) throw new FleetRequestError('Down', null);
      return fleet;
    },
  });
  renderFleet(client, { refreshIntervalMs: 20 });
  await screen.findByRole('article', { name: 'Storm' });

  fail = true;

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Cerebra couldn’t load this fleet.');
  expect(alert.textContent).toContain(
    'Your saved view is still here, but it may be out of date.',
  );
  expect(screen.getByRole('article', { name: 'Storm' })).toBeTruthy();

  fail = false;
  await userEvent.click(
    within(alert).getByRole('button', { name: 'Try again' }),
  );
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

test('a first read that fails is an error, never an empty fleet', async () => {
  renderFleet(
    createClient({
      read: async () => {
        throw new FleetRequestError('Down', null);
      },
    }),
  );

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Cerebra couldn’t load this fleet.',
  );
  expect(screen.queryByText('No people in this fleet yet')).toBeNull();
});

test('an empty fleet invites adding someone', async () => {
  renderFleet(createClient({ read: async () => ({ ...fleet, people: [] }) }));

  expect(await screen.findByText('No people in this fleet yet')).toBeTruthy();
  expect(
    screen.getByText('Add someone to begin working with this project.'),
  ).toBeTruthy();
  expect(
    screen.getAllByRole('button', { name: 'Add person' }).length,
  ).toBeGreaterThan(0);
});

test('stopping asks first; Keep working and Escape leave the work running', async () => {
  const stopped: string[] = [];
  renderFleet(createClient({ stop: async (id) => void stopped.push(id) }));
  const stop = within(
    await screen.findByRole('article', { name: 'Storm' }),
  ).getByRole('button', { name: 'Stop' });

  await userEvent.click(stop);
  const dialog = screen.getByRole('dialog', { name: 'Stop Storm?' });
  expect(dialog.textContent).toContain(
    'Storm will stop working on ‘Make reports easier to share.’',
  );
  expect(document.activeElement).toBe(
    within(dialog).getByRole('button', { name: 'Keep working' }),
  );

  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(stop);

  await userEvent.click(stop);
  await userEvent.click(screen.getByRole('button', { name: 'Keep working' }));
  expect(document.activeElement).toBe(stop);
  expect(stopped).toEqual([]);

  await userEvent.click(stop);
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop' }),
  );
  await waitFor(() => expect(stopped).toEqual(['agent-storm']));
});

test('a refused start names the person and the reason', async () => {
  renderFleet(
    createClient({
      start: async () => {
        throw new FleetRequestError('Cerebra can’t run agents yet.', null);
      },
    }),
  );

  await userEvent.click(
    within(await screen.findByRole('article', { name: 'Cleo' })).getByRole(
      'button',
      { name: 'Start' },
    ),
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Cerebra couldn’t start Cleo.');
  expect(alert.textContent).toContain('Cerebra can’t run agents yet.');
});

test('Open chat hands the person to the conversation once started', async () => {
  const opened: string[] = [];
  renderFleet(createClient(), {
    onOpenChat: (chosen) => opened.push(chosen.name),
  });

  await userEvent.click(
    within(await screen.findByRole('article', { name: 'Astra' })).getByRole(
      'button',
      { name: 'Open chat' },
    ),
  );

  await waitFor(() => expect(opened).toEqual(['Astra']));
});

test('View work opens the held item', async () => {
  const viewed: string[] = [];
  renderFleet(createClient(), { onViewWork: (id) => viewed.push(id) });

  await userEvent.click(
    within(await screen.findByRole('article', { name: 'Magma' })).getByRole(
      'button',
      { name: 'View work' },
    ),
  );

  expect(viewed).toEqual(['item-2']);
});

test('removing asks first, and a person with work cannot be removed', async () => {
  const removed: string[] = [];
  renderFleet(
    createClient({ removePerson: async (id) => void removed.push(id) }),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: 'More actions for Magma' }),
  );
  await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
  expect(screen.getByRole('alert').textContent).toContain(
    'Stop this work before removing Magma.',
  );
  expect(screen.queryByRole('dialog')).toBeNull();

  const more = screen.getByRole('button', { name: 'More actions for Cleo' });
  await userEvent.click(more);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove Cleo?' });
  expect(dialog.textContent).toContain(
    'Cleo has no work in hand. This removes Cleo from this project.',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(removed).toEqual([]);

  await userEvent.click(more);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
  await userEvent.click(screen.getByRole('button', { name: 'Remove person' }));
  await waitFor(() => expect(removed).toEqual(['agent-cleo']));
  await waitFor(() =>
    expect(screen.queryByRole('article', { name: 'Cleo' })).toBeNull(),
  );
});

test('adds a person and refuses a name already in the fleet', async () => {
  const added: unknown[] = [];
  renderFleet(
    createClient({
      addPerson: async (projectId, input) => {
        added.push({ input, projectId });
        if (input.name === 'Storm') {
          throw new FleetRequestError(
            'Another person in this fleet is already called Storm.',
            'duplicate_name',
          );
        }
        return person(input.name, 'producer', { id: 'agent-rogue' });
      },
    }),
  );
  await screen.findByRole('article', { name: 'Storm' });

  await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
  const dialog = screen.getByRole('dialog', { name: 'Add person' });
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add person' }),
  );
  expect(within(dialog).getByText('Enter a name.')).toBeTruthy();

  await userEvent.type(within(dialog).getByLabelText('Name'), 'Storm');
  await userEvent.selectOptions(
    within(dialog).getByLabelText('Role'),
    'Producer',
  );
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add person' }),
  );
  expect(
    await within(dialog).findByText(
      'Another person in this fleet is already called Storm.',
    ),
  ).toBeTruthy();

  await userEvent.clear(within(dialog).getByLabelText('Name'));
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Rogue');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Add person' }),
  );

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(added.at(-1)).toEqual({
    input: { name: 'Rogue', typeId: 'type-producer' },
    projectId: 'project-1',
  });
  expect(screen.getByRole('article', { name: 'Rogue' })).toBeTruthy();
});

test('renames and disables a person from its menu', async () => {
  const changes: unknown[] = [];
  let cleo = person('Cleo', 'designer');
  renderFleet(
    createClient({
      updatePerson: async (agentId, change) => {
        changes.push({ agentId, change });
        cleo = { ...cleo, ...change };
        return cleo;
      },
    }),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: 'More actions for Cleo' }),
  );
  await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  const dialog = screen.getByRole('dialog', { name: 'Rename Cleo' });
  await userEvent.clear(within(dialog).getByLabelText('Name'));
  await userEvent.type(within(dialog).getByLabelText('Name'), 'Clea');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Save name' }),
  );
  expect(await screen.findByRole('article', { name: 'Clea' })).toBeTruthy();

  await userEvent.click(
    screen.getByRole('button', { name: 'More actions for Clea' }),
  );
  await userEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
  expect(
    await within(screen.getByRole('article', { name: 'Clea' })).findByText(
      'Disabled',
    ),
  ).toBeTruthy();
  expect(changes).toEqual([
    { agentId: 'agent-cleo', change: { name: 'Clea' } },
    { agentId: 'agent-cleo', change: { enabled: false } },
  ]);
});

test('filters narrow the people and are remembered across projects', async () => {
  const storage = memoryStorage();
  const view = renderFleet(createClient(), { storage });
  await screen.findByRole('article', { name: 'Storm' });

  await userEvent.selectOptions(screen.getByLabelText('Role'), 'Producer');
  await userEvent.selectOptions(screen.getByLabelText('Status'), 'Working now');
  expect(
    within(screen.getByRole('region', { name: 'People in this fleet' }))
      .getAllByRole('article')
      .map((article) => article.getAttribute('aria-label')),
  ).toEqual(['Magma']);

  view.unmount();
  renderFleet(createClient(), { projectId: 'project-2', storage });
  await screen.findByRole('article', { name: 'Magma' });
  expect(screen.queryByRole('article', { name: 'Storm' })).toBeNull();

  await userEvent.selectOptions(screen.getByLabelText('Status'), 'Disabled');
  expect(screen.getByText('No one matches these filters.')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getAllByRole('article')).toHaveLength(5);
});

test('the roles view lists every role with its settings and people', async () => {
  renderFleet();
  await screen.findByRole('article', { name: 'Storm' });

  await userEvent.click(screen.getByRole('tab', { name: 'Roles' }));

  const producer = screen.getByRole('article', { name: 'Producer' });
  expect(producer.textContent).toContain('Conversation model: Claude Opus');
  expect(producer.textContent).toContain('Start when work is ready');
  expect(producer.textContent).toContain('Storm');
  expect(producer.textContent).toContain('Magma');
  expect(
    screen.getByRole('article', { name: 'Groomer' }).textContent,
  ).toContain('No one in this role yet');
  expect(
    screen.getByRole('article', { name: 'Designer' }).textContent,
  ).toContain('Start only when I choose');
  expect(screen.getAllByRole('article')).toHaveLength(6);
});

test('role settings save, show progress, and return to the roles view', async () => {
  let finish: (() => void) | undefined;
  const saved: unknown[] = [];
  renderFleet(
    createClient({
      saveRoleSettings: (_projectId, typeId, settings) => {
        saved.push({ settings, typeId });
        return new Promise((resolve) => {
          finish = () =>
            resolve({ ...role('producer', ['Storm', 'Magma']), ...settings });
        });
      },
    }),
  );
  await screen.findByRole('article', { name: 'Storm' });
  await userEvent.click(screen.getByRole('tab', { name: 'Roles' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Change producer settings' }),
  );

  expect(
    screen.getByRole('heading', { level: 2, name: 'Role settings' }),
  ).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Producer' })).toBeTruthy();
  expect(
    screen.getByText(
      'These choices apply to every producer in northstar/admin. They do not interrupt work already under way.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole('radiogroup', { name: 'When producers start' }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Cerebra assigns the next ready change to an available producer.',
    ),
  ).toBeTruthy();

  await userEvent.selectOptions(
    screen.getByLabelText('Conversation model'),
    'Claude Sonnet',
  );
  await userEvent.click(
    screen.getByRole('radio', { name: /Start only when I choose/ }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(
    screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement,
  ).toHaveProperty('disabled', true);
  finish?.();

  const producer = await screen.findByRole('article', { name: 'Producer' });
  expect(producer.textContent).toContain('Conversation model: Claude Sonnet');
  expect(producer.textContent).toContain('Start only when I choose');
  expect(saved).toEqual([
    {
      settings: { model: 'sonnet', startMode: 'manual' },
      typeId: 'type-producer',
    },
  ]);
});

test('a failed save keeps the choices and offers Try again', async () => {
  let attempts = 0;
  renderFleet(
    createClient({
      saveRoleSettings: async (_projectId, typeId, settings) => {
        attempts += 1;
        if (attempts === 1) throw new FleetRequestError('Down', null);
        return { ...role('producer', ['Storm', 'Magma']), ...settings, typeId };
      },
    }),
  );
  await screen.findByRole('article', { name: 'Storm' });
  await userEvent.click(screen.getByRole('tab', { name: 'Roles' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Change producer settings' }),
  );
  await userEvent.selectOptions(
    screen.getByLabelText('Conversation model'),
    'Claude Haiku',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(
    'Cerebra couldn’t save the producer settings.',
  );
  expect(
    screen.getByLabelText('Conversation model') as HTMLSelectElement,
  ).toHaveProperty('value', 'haiku');

  await userEvent.click(
    within(alert).getByRole('button', { name: 'Try again' }),
  );
  expect(
    (await screen.findByRole('article', { name: 'Producer' })).textContent,
  ).toContain('Conversation model: Claude Haiku');
});

test('the assistant settings offer no start choice, and Cancel returns to roles', async () => {
  renderFleet();
  await screen.findByRole('article', { name: 'Storm' });
  await userEvent.click(screen.getByRole('tab', { name: 'Roles' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Change assistant settings' }),
  );

  expect(screen.queryByRole('radiogroup')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('article', { name: 'Assistant' })).toBeTruthy();
});
