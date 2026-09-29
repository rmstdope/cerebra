import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  agentTypesDirectory,
  InvalidAgentTypeError,
  parseAgentTypeDefinition,
  readAgentTypeDefinitions,
} from './agent-types.js';

const valid = {
  backend: 'claude',
  defaultCount: 2,
  effort: 'high',
  idleTimeoutSeconds: 1800,
  image: 'cerebro-agent',
  interactive: false,
  model: 'sonnet',
  name: 'producer',
  names: ['Cyclops', 'Storm'],
  network: 'unrestricted',
  resources: { cpus: 2, memoryMb: 4096 },
  role: 'producer',
  secrets: ['CLAUDE_CODE_OAUTH_TOKEN'],
  serves: { states: ['build_ready'] },
  skills: [],
  tools: ['get_item'],
  triggers: [{ kind: 'state' }, { kind: 'navigator' }],
};

describe('agent type definitions', () => {
  test('the shipped definitions are the six MVP roles with their default fleets', async () => {
    const definitions = await readAgentTypeDefinitions(agentTypesDirectory);

    expect(
      definitions.map((definition) => [
        definition.role,
        definition.defaultCount,
        definition.names.slice(0, definition.defaultCount),
      ]),
    ).toEqual([
      ['assistant', 1, ['Cerebro']],
      ['groomer', 1, ['Jubilee']],
      ['designer', 1, ['Xavier']],
      ['producer', 2, ['Cyclops', 'Storm']],
      ['bugfixer', 1, ['Bishop']],
      ['reviewer', 1, ['Emma']],
    ]);
    for (const definition of definitions) {
      expect(definition.instructions.trim().length).toBeGreaterThan(0);
      expect(definition.backend).toBe('claude');
    }
    const assistant = definitions[0];
    expect(assistant.interactive).toBe(true);
    expect(assistant.triggers).toEqual([{ kind: 'navigator' }]);
  });

  test('parses a complete definition and keeps its instructions', () => {
    const definition = parseAgentTypeDefinition(valid, 'Build it.', 'x.json');

    expect(definition.name).toBe('producer');
    expect(definition.instructions).toBe('Build it.');
    expect(definition.triggers).toEqual([
      { kind: 'state' },
      { kind: 'navigator' },
    ]);
  });

  test.each([
    ['name', ''],
    ['role', 'orchestrator'],
    ['backend', 'copilot'],
    ['model', 'gpt'],
    ['interactive', 'yes'],
    ['triggers', [{ kind: 'cron' }]],
    ['defaultCount', -1],
    ['names', ['Cyclops']],
  ])('refuses a definition whose %s is invalid', (field, value) => {
    expect(() =>
      parseAgentTypeDefinition({ ...valid, [field]: value }, 'x', 'bad.json'),
    ).toThrow(new InvalidAgentTypeError('bad.json', field));
  });

  test('refuses a definition with no instructions', () => {
    expect(() => parseAgentTypeDefinition(valid, '  ', 'bad.json')).toThrow(
      new InvalidAgentTypeError('bad.json', 'instructions'),
    );
  });

  test('a definition file without its instructions file is refused', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-types-'));
    try {
      await writeFile(join(directory, 'producer.json'), JSON.stringify(valid));
      await expect(readAgentTypeDefinitions(directory)).rejects.toThrow(
        /producer\.md/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
