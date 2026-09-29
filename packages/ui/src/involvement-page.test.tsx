import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import {
  InvolvementRequestError,
  type InvolvementClient,
  type InvolvementSetting,
} from './involvement';
import { InvolvementPage } from './involvement-page';

afterEach(cleanup);

function involvementClient(
  overrides: Partial<InvolvementClient> = {},
  initial: InvolvementSetting = {
    involvement: 'autonomous',
    reviewAccount: null,
  },
): InvolvementClient & { saved: InvolvementSetting[] } {
  const saved: InvolvementSetting[] = [];
  let current = initial;
  return {
    saved,
    get: async () => current,
    save: async (_projectId, setting) => {
      saved.push(setting);
      current = setting;
      return setting;
    },
    ...overrides,
  };
}

test('offers the three presets as one choice, Autonomous by default', async () => {
  render(
    <InvolvementPage client={involvementClient()} projectId="project-1" />,
  );

  const group = await screen.findByRole('radiogroup', {
    name: 'How closely you follow the builders',
  });
  const autonomous = screen.getByRole('radio', { name: /^Autonomous/ });
  expect(group).toBeTruthy();
  expect((autonomous as HTMLInputElement).checked).toBe(true);
  expect(
    screen.getByText(
      'Builders plan, build and merge on their own. The reviewer agent still reviews everything.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Each builder waits for you to approve its plan before writing code.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'You also review every pull request on GitHub before it merges.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Changes apply the next time a builder reaches a plan or a review. Work already waiting for you stays waiting.',
    ),
  ).toBeTruthy();
  expect(screen.queryByLabelText('Your GitHub account for reviews')).toBeNull();
});

test('saves Approve plans', async () => {
  const client = involvementClient();
  render(<InvolvementPage client={client} projectId="project-1" />);

  await userEvent.click(
    await screen.findByRole('radio', { name: /^Approve plans$/ }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(client.saved).toEqual([
    { involvement: 'plan', reviewAccount: null },
  ]);
});

test('asks for the account when code review is chosen, focusing the empty field', async () => {
  const client = involvementClient();
  render(<InvolvementPage client={client} projectId="project-1" />);

  await userEvent.click(
    await screen.findByRole('radio', { name: /^Approve plans and code/ }),
  );
  const account = screen.getByLabelText('Your GitHub account for reviews');
  expect(document.activeElement).toBe(account);
  expect(screen.getByText('Only a review from this account counts.')).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    screen.getByText('Enter the GitHub account whose review counts.'),
  ).toBeTruthy();
  expect(account.getAttribute('aria-invalid')).toBe('true');
  expect(client.saved).toEqual([]);

  await userEvent.type(account, 'navigator');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(client.saved).toEqual([
    { involvement: 'full', reviewAccount: 'navigator' },
  ]);
});

test('shows a saved account without moving focus to it', async () => {
  render(
    <InvolvementPage
      client={involvementClient(
        {},
        { involvement: 'full', reviewAccount: 'navigator' },
      )}
      projectId="project-1"
    />,
  );

  const account = await screen.findByLabelText(
    'Your GitHub account for reviews',
  );
  expect((account as HTMLInputElement).value).toBe('navigator');
  expect(document.activeElement).not.toBe(account);
});

test('says when a save failed and when the server refused the account', async () => {
  let refuse = true;
  const client = involvementClient({
    save: async () => {
      if (refuse) {
        throw new InvolvementRequestError(
          'Enter a GitHub account name, like octocat.',
          true,
        );
      }
      throw new InvolvementRequestError('Request failed.', false);
    },
  });
  render(<InvolvementPage client={client} projectId="project-1" />);

  await userEvent.click(
    await screen.findByRole('radio', { name: /^Approve plans and code/ }),
  );
  await userEvent.type(
    screen.getByLabelText('Your GitHub account for reviews'),
    'x',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await screen.findByText('Enter a GitHub account name, like octocat.'),
  ).toBeTruthy();

  refuse = false;
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    (await screen.findByRole('alert')).textContent,
  ).toBe("Settings weren't saved. Try again.");
});

test('never shows a failed read as the default', async () => {
  let fail = true;
  render(
    <InvolvementPage
      client={involvementClient({
        get: async () => {
          if (fail) throw new Error('down');
          return { involvement: 'plan', reviewAccount: null };
        },
      })}
      projectId="project-1"
    />,
  );

  expect(
    await screen.findByText(/Cerebra couldn’t load this setting/),
  ).toBeTruthy();
  expect(screen.queryByRole('radio')).toBeNull();

  fail = false;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    (
      (await screen.findByRole('radio', {
        name: /^Approve plans$/,
      })) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test('asks for a project first', () => {
  render(<InvolvementPage client={involvementClient()} projectId={null} />);

  expect(
    screen.getByText(
      'Add a project first, then choose how closely you follow its builders.',
    ),
  ).toBeTruthy();
});
