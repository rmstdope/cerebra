import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import {
  LimitRequestError,
  type AutomaticStartsClient,
  type Limits,
} from './automatic-starts';
import { LimitsPage } from './limits-page';

afterEach(cleanup);

function limitsClient(
  overrides: Partial<AutomaticStartsClient> = {},
): AutomaticStartsClient & { saved: string[] } {
  const saved: string[] = [];
  let limits: Limits = { instanceLimit: 6, projectLimit: 3 };
  return {
    saved,
    limits: async (projectId) => ({
      ...limits,
      projectLimit: projectId === null ? null : limits.projectLimit,
    }),
    saveInstanceLimit: async (value) => {
      saved.push(`instance ${value}`);
      limits = { ...limits, instanceLimit: value };
      return { instanceLimit: value, projectLimit: null };
    },
    saveProjectLimit: async (_projectId, value) => {
      saved.push(`project ${value}`);
      limits = { ...limits, projectLimit: value };
      return limits;
    },
    setPaused: async () => undefined,
    status: async () => {
      throw new Error('Not exercised');
    },
    ...overrides,
  };
}

test('shows both limits with the Cerebra-wide hint and saves each', async () => {
  const client = limitsClient();
  render(<LimitsPage client={client} projectId="project-1" />);

  const project = await screen.findByLabelText(
    'Work running at once in this project',
  );
  const instance = screen.getByLabelText(
    'Work running at once across all projects',
  );
  expect((project as HTMLInputElement).value).toBe('3');
  expect((instance as HTMLInputElement).value).toBe('6');
  expect(screen.getByText('Cerebra-wide limit is 6.')).toBeTruthy();

  await userEvent.clear(project);
  await userEvent.type(project, '2');
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Save changes' })[0]!,
  );
  await userEvent.clear(instance);
  await userEvent.type(instance, '8');
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Save changes' })[1]!,
  );

  expect(await screen.findByText('Cerebra-wide limit is 8.')).toBeTruthy();
  expect(client.saved).toEqual(['project 2', 'instance 8']);
});

test('shows only the Cerebra-wide limit when there is no project', async () => {
  render(<LimitsPage client={limitsClient()} projectId={null} />);

  expect(
    await screen.findByLabelText('Work running at once across all projects'),
  ).toBeTruthy();
  expect(
    screen.queryByLabelText('Work running at once in this project'),
  ).toBeNull();
});

test('refuses values that are not whole numbers of 1 or more and saves nothing', async () => {
  const client = limitsClient();
  render(<LimitsPage client={client} projectId="project-1" />);
  const project = await screen.findByLabelText(
    'Work running at once in this project',
  );
  const save = screen.getAllByRole('button', { name: 'Save changes' })[0]!;

  for (const entry of ['0', '1.5', 'two']) {
    await userEvent.clear(project);
    await userEvent.type(project, entry);
    await userEvent.click(save);
    expect(screen.getByText('Enter a whole number of 1 or more.')).toBeTruthy();
  }
  await userEvent.clear(project);
  await userEvent.click(save);

  expect(screen.getByText('Enter a whole number of 1 or more.')).toBeTruthy();
  expect(project.getAttribute('aria-invalid')).toBe('true');
  expect(client.saved).toEqual([]);
});

test('refuses a project limit above the Cerebra-wide limit', async () => {
  const client = limitsClient();
  render(<LimitsPage client={client} projectId="project-1" />);
  const project = await screen.findByLabelText(
    'Work running at once in this project',
  );

  await userEvent.clear(project);
  await userEvent.type(project, '7');
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Save changes' })[0]!,
  );

  expect(
    screen.getByText("This can't be higher than the Cerebra-wide limit (6)."),
  ).toBeTruthy();
  expect(client.saved).toEqual([]);
});

test('shows a refusal from Cerebra under the field and Cancel restores the saved value', async () => {
  render(
    <LimitsPage
      client={limitsClient({
        saveProjectLimit: async () => {
          throw new LimitRequestError(
            "This can't be higher than the Cerebra-wide limit (4).",
            true,
          );
        },
      })}
      projectId="project-1"
    />,
  );
  const project = await screen.findByLabelText(
    'Work running at once in this project',
  );

  await userEvent.clear(project);
  await userEvent.type(project, '5');
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Save changes' })[0]!,
  );

  expect(
    await screen.findByText(
      "This can't be higher than the Cerebra-wide limit (4).",
    ),
  ).toBeTruthy();

  await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);

  expect((project as HTMLInputElement).value).toBe('3');
  expect(
    screen.queryByText("This can't be higher than the Cerebra-wide limit (4)."),
  ).toBeNull();
});

test('reports a failed read and a failed save honestly', async () => {
  let failing = true;
  render(
    <LimitsPage
      client={limitsClient({
        limits: async () => {
          if (failing) throw new Error('offline');
          return { instanceLimit: 6, projectLimit: null };
        },
        saveInstanceLimit: async () => {
          throw new Error('offline');
        },
      })}
      projectId={null}
    />,
  );

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Cerebra couldn’t load the limits.',
  );
  failing = false;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Save changes' }),
  );

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Cerebra couldn’t save this limit. Nothing has changed.',
  );
});
