// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { installProjectSkills } from './skills.js';

const made: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cerebra-skills-'));
  made.push(path);
  return path;
}

async function skill(
  checkout: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    const path = join(checkout, '.cerebro', 'skills', name, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
}

afterEach(async () => {
  await Promise.all(
    made.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('installing project skills', () => {
  test('copies each listed skill from the checkout, replacing an older copy', async () => {
    const checkout = await directory();
    const configDir = await directory();
    await skill(checkout, 'produce-bead', {
      'SKILL.md': '# Produce',
      'references/steps.md': 'steps',
    });
    await skill(checkout, 'unlisted', { 'SKILL.md': '# Unlisted' });
    await mkdir(join(configDir, 'skills', 'produce-bead'), { recursive: true });
    await writeFile(
      join(configDir, 'skills', 'produce-bead', 'stale.md'),
      'old',
    );
    await mkdir(join(configDir, 'skills', 'personal'), { recursive: true });

    await installProjectSkills({
      checkout,
      configDir,
      names: ['produce-bead'],
    });

    expect((await readdir(join(configDir, 'skills'))).sort()).toEqual([
      'personal',
      'produce-bead',
    ]);
    expect(
      (await readdir(join(configDir, 'skills', 'produce-bead'))).sort(),
    ).toEqual(['SKILL.md', 'references']);
    await expect(
      readFile(
        join(configDir, 'skills', 'produce-bead', 'references', 'steps.md'),
        'utf8',
      ),
    ).resolves.toBe('steps');
  });

  test('refuses a listed skill the checkout does not have, naming it', async () => {
    const checkout = await directory();
    const configDir = await directory();
    await skill(checkout, 'no-manifest', { 'notes.md': 'x' });

    await expect(
      installProjectSkills({ checkout, configDir, names: ['missing'] }),
    ).rejects.toThrow(
      'Skill missing is not in the checkout at .cerebro/skills/missing/SKILL.md',
    );
    await expect(
      installProjectSkills({ checkout, configDir, names: ['no-manifest'] }),
    ).rejects.toThrow(
      'Skill no-manifest is not in the checkout at .cerebro/skills/no-manifest/SKILL.md',
    );
  });

  test('refuses a skill name that is a path', async () => {
    const checkout = await directory();
    const configDir = await directory();

    await expect(
      installProjectSkills({ checkout, configDir, names: ['../escape'] }),
    ).rejects.toThrow('Skill name ../escape is not a plain name');
  });
});
