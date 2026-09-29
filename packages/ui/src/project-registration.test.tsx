import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import { ProjectRegistration } from './project-registration';

afterEach(cleanup);

test('registers a discovered GitHub project with an editable prefix', async () => {
  const user = userEvent.setup();
  const registrations: Array<{ prefix: string }> = [];

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
          registrations.push({ prefix: input.prefix });
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
  expect(registrations).toEqual([{ prefix: 'SITE' }]);
});
