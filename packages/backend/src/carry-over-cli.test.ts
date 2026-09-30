import { expect, test } from 'vitest';

import { runCarryOver } from './carry-over-cli.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

function collect() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

test('prints each old item with its new key and state', async () => {
  await withTestDatabase(async (database) => {
    await registerTestProject(database, 'website');
    const output = collect();

    const code = await runCarryOver({
      database,
      input: JSON.stringify({
        items: [
          {
            oldName: 'cr-2co',
            priority: 'P1',
            state: 'build_ready',
            title: 'Refuse subpaths',
            type: 'bug',
          },
          {
            notCarriedOver: 'the handover itself',
            oldName: 'cr-knk',
            title: 'Move onto Cerebra',
            type: 'task',
          },
        ],
        project: 'acme/website',
      }),
      write: output.write,
    });

    expect(code).toBe(0);
    expect(output.lines).toEqual([
      'cr-2co → WEB-1 (build_ready)',
      'cr-knk → WEB-2 (cancelled)',
      'Carried over 2 items into acme/website.',
    ]);
  });
});

test('says why it refused, files nothing and exits non-zero', async () => {
  await withTestDatabase(async (database) => {
    await registerTestProject(database, 'website');
    const output = collect();

    expect(
      await runCarryOver({ database, input: '{', write: output.write }),
    ).toBe(1);
    expect(output.lines).toEqual([
      'Nothing was carried over: the manifest is not valid JSON.',
    ]);

    output.lines.length = 0;
    expect(
      await runCarryOver({
        database,
        input: JSON.stringify({ items: [], project: 'acme/elsewhere' }),
        write: output.write,
      }),
    ).toBe(1);
    expect(output.lines).toEqual([
      'Nothing was carried over: No project acme/elsewhere is registered.',
    ]);
  });
});
