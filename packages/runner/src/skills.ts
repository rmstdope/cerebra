import { access, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const plainName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Puts each named project skill where Claude finds user skills, replacing any older copy
 * (spec §5.5). Skills already there under other names are left alone.
 */
export async function installProjectSkills(context: {
  readonly checkout: string;
  readonly configDir: string;
  readonly names: readonly string[];
}): Promise<void> {
  for (const name of context.names) {
    if (!plainName.test(name)) {
      throw new Error(`Skill name ${name} is not a plain name`);
    }
    const source = join(context.checkout, '.cerebro', 'skills', name);
    try {
      await access(join(source, 'SKILL.md'));
    } catch {
      throw new Error(
        `Skill ${name} is not in the checkout at .cerebro/skills/${name}/SKILL.md`,
      );
    }
    const target = join(context.configDir, 'skills', name);
    await rm(target, { recursive: true, force: true });
    await mkdir(join(context.configDir, 'skills'), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}
