import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import { ProjectRegistration } from './project-registration';

afterEach(cleanup);

test('registers a discovered GitHub project with an editable prefix', async () => {
  const user = userEvent.setup();
  const registrations: Array<{ prefix: string; credential: string }> = [];

  render(
    <ProjectRegistration
      projectClient={{
        discover: async () => ({
          defaultBranch: 'main',
          name: 'website',
          owner: 'acme',
          prefix: 'WEBSITE',
          remote: 'https://github.com/acme/website.git',
        }),
        register: async (input) => {
          registrations.push({
            prefix: input.prefix,
            credential: input.credential,
          });
          return {
            defaultBranch: 'main',
            id: 'project-id',
            name: 'website',
            owner: 'acme',
            prefix: input.prefix,
            remote: 'https://github.com/acme/website.git',
          };
        },
      }}
    />,
  );

  await user.type(
    screen.getByLabelText('GitHub repository link'),
    'https://github.com/acme/website',
  );
  await user.type(screen.getByLabelText('GitHub access token'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Continue' }));

  expect(
    await screen.findByRole('heading', { name: 'Check the project settings' }),
  ).toBeTruthy();
  await user.clear(screen.getByLabelText('Project prefix'));
  await user.type(screen.getByLabelText('Project prefix'), 'SITE');
  await user.click(screen.getByRole('button', { name: 'Add project' }));

  expect(await screen.findByText('Your project is ready')).toBeTruthy();
  expect(registrations).toEqual([{ prefix: 'SITE', credential: 'secret' }]);
});

test('shows the backend failure reason and clears the token before retrying', async () => {
  const user = userEvent.setup();
  const reason =
    'The disk is full. Free space in the Podman machine, then try again.';
  render(
    <ProjectRegistration
      projectClient={{
        discover: async () => ({
          defaultBranch: 'main',
          name: 'website',
          owner: 'acme',
          prefix: 'SITE',
          remote: 'https://github.com/acme/website.git',
        }),
        register: async () => {
          throw new Error(reason);
        },
      }}
    />,
  );
  await user.type(
    screen.getByLabelText('GitHub repository link'),
    'https://github.com/acme/website',
  );
  await user.type(screen.getByLabelText('GitHub access token'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(await screen.findByRole('button', { name: 'Add project' }));
  expect((await screen.findByRole('alert')).textContent).toBe(reason);
  expect(screen.queryByText(/Check that GitHub is available/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    screen.getByLabelText<HTMLInputElement>('GitHub access token').value,
  ).toBe('');
});
