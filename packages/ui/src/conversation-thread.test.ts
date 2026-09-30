import { expect, test } from 'vitest';

import {
  buildThread,
  describeStep,
  exitCodeOf,
  fileChangeOf,
  lineDiff,
  planSectionsOf,
  stepCountOf,
  type ThreadItem,
} from './conversation-thread';
import type { RecordedEvent, RunEvent } from './runs';

const at = '2026-10-01T09:30:00.000Z';

function records(events: readonly RunEvent[]): RecordedEvent[] {
  return events.map((event, index) => ({
    createdAt: at,
    event,
    position: index + 1,
  }));
}

function kinds(items: readonly ThreadItem[]): string[] {
  return items.map((item) => item.kind);
}

test('a step pairs its call with its result, in the order it was called', () => {
  const items = buildThread(
    records([
      { kind: 'message', text: 'Looking.' },
      {
        input: { file_path: 'src/a.ts' },
        kind: 'tool_call',
        name: 'Read',
        toolCallId: 't1',
      },
      {
        input: { command: 'pnpm test' },
        kind: 'tool_call',
        name: 'Bash',
        toolCallId: 't2',
      },
      { content: 'one', isError: false, kind: 'tool_result', toolCallId: 't1' },
      { kind: 'message', text: 'Done.' },
    ]),
  );

  expect(kinds(items)).toEqual(['assistant', 'step', 'step', 'assistant']);
  expect(items[1]).toMatchObject({
    name: 'Read',
    result: { content: 'one', isError: false },
    toolCallId: 't1',
  });
  expect(items[2]).toMatchObject({ result: null, toolCallId: 't2' });
});

test('a helper holds what it does, nested helpers included, and counts its own steps', () => {
  const items = buildThread(
    records([
      {
        description: 'Review the diff',
        kind: 'subagent_start',
        subagentType: 'reviewer',
        toolCallId: 'h1',
      },
      { kind: 'message', parentToolCallId: 'h1', text: 'Reading.' },
      {
        input: {},
        kind: 'tool_call',
        name: 'Read',
        parentToolCallId: 'h1',
        toolCallId: 't1',
      },
      {
        content: 'x',
        isError: false,
        kind: 'tool_result',
        parentToolCallId: 'h1',
        toolCallId: 't1',
      },
      {
        description: '',
        kind: 'subagent_start',
        parentToolCallId: 'h1',
        subagentType: 'explore',
        toolCallId: 'h2',
      },
      {
        input: {},
        kind: 'tool_call',
        name: 'Grep',
        parentToolCallId: 'h2',
        toolCallId: 't2',
      },
      { isError: false, kind: 'subagent_end', toolCallId: 'h1' },
    ]),
  );

  expect(kinds(items)).toEqual(['helper']);
  const helper = items[0];
  if (helper?.kind !== 'helper') throw new Error('not a helper');
  expect(helper.task).toBe('Review the diff');
  expect(helper.end).toEqual({ isError: false });
  expect(kinds(helper.items)).toEqual(['assistant', 'step', 'helper']);
  const nested = helper.items[2];
  if (nested?.kind !== 'helper') throw new Error('not a helper');
  expect(nested.task).toBe('explore');
  expect(nested.end).toBeNull();
  expect(kinds(nested.items)).toEqual(['step']);
  expect(stepCountOf(helper)).toBe(2);
});

test('an event whose helper is unknown stays in the main thread', () => {
  const items = buildThread(
    records([{ kind: 'message', parentToolCallId: 'gone', text: 'Hi' }]),
  );
  expect(kinds(items)).toEqual(['assistant']);
});

test('an answered question is shown as asked and answered where it was answered', () => {
  const items = buildThread(
    records([
      {
        kind: 'question',
        questionId: 'q1',
        questions: [
          { header: '', multiSelect: false, options: [], question: 'Which?' },
        ],
      },
      { answers: { 'Which?': 'That' }, kind: 'answer', questionId: 'q1' },
      { kind: 'user_message', text: 'Thanks' },
    ]),
  );
  expect(
    items.map((item) =>
      item.kind === 'assistant' || item.kind === 'navigator'
        ? `${item.kind}:${item.text}`
        : item.kind,
    ),
  ).toEqual(['assistant:Which?', 'navigator:That', 'navigator:Thanks']);
});

test('each kind of step is described in a few words', () => {
  expect(describeStep('Bash', { command: 'pnpm test\n  --watch' })).toBe(
    'Ran pnpm test',
  );
  expect(describeStep('Read', { file_path: 'src/a.ts' })).toBe('Read src/a.ts');
  expect(describeStep('Edit', { file_path: 'src/a.ts' })).toBe(
    'Edited src/a.ts',
  );
  expect(describeStep('MultiEdit', { file_path: 'src/a.ts' })).toBe(
    'Edited src/a.ts',
  );
  expect(describeStep('Write', { file_path: 'b.md' })).toBe('Wrote b.md');
  expect(describeStep('Grep', { pattern: 'transition' })).toBe(
    'Searched “transition”',
  );
  expect(describeStep('Glob', { pattern: '**/*.ts' })).toBe(
    'Found files matching “**/*.ts”',
  );
  expect(describeStep('WebFetch', { url: 'https://x.test' })).toBe(
    'Fetched https://x.test',
  );
  expect(describeStep('WebSearch', { query: 'vite' })).toBe(
    'Searched the web for “vite”',
  );
  expect(describeStep('TodoWrite', {})).toBe('Updated the to-do list');
  expect(describeStep('Read', {})).toBe('Used Read');
  expect(describeStep('mcp__cerebra__file', null)).toBe(
    'Used mcp__cerebra__file',
  );
});

test('file changes are read from Edit, MultiEdit and Write', () => {
  expect(
    fileChangeOf('Edit', {
      file_path: 'src/board.ts',
      new_string: 'const x = 2\nlog(x)',
      old_string: 'const x = 1',
    }),
  ).toEqual({
    lines: [
      { kind: 'removed', text: 'const x = 1' },
      { kind: 'added', text: 'const x = 2' },
      { kind: 'added', text: 'log(x)' },
    ],
    path: 'src/board.ts',
  });
  expect(
    fileChangeOf('MultiEdit', {
      edits: [
        { new_string: 'b', old_string: 'a' },
        { new_string: 'd', old_string: 'c' },
      ],
      file_path: 'f',
    })?.lines,
  ).toEqual([
    { kind: 'removed', text: 'a' },
    { kind: 'added', text: 'b' },
    { kind: 'removed', text: 'c' },
    { kind: 'added', text: 'd' },
  ]);
  expect(fileChangeOf('Write', { content: 'a\nb', file_path: 'n' })).toEqual({
    lines: [
      { kind: 'added', text: 'a' },
      { kind: 'added', text: 'b' },
    ],
    path: 'n',
  });
  expect(fileChangeOf('Read', { file_path: 'f' })).toBeNull();
  expect(fileChangeOf('Edit', { file_path: 'f' })).toBeNull();
});

test('a line diff keeps unchanged lines between the changes', () => {
  expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'added', text: 'B' },
    { kind: 'same', text: 'c' },
  ]);
});

test('a very large change falls back to all removed then all added', () => {
  const before = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
  const after = `${before}\nnew`;
  const lines = lineDiff(before, after);
  expect(lines.filter((line) => line.kind === 'removed')).toHaveLength(500);
  expect(lines.filter((line) => line.kind === 'added')).toHaveLength(501);
});

test('an exit code is read from a failed command’s output', () => {
  expect(exitCodeOf('Exit code 1\nFAIL src/a.test.ts')).toBe(1);
  expect(exitCodeOf('Error: Exit code 127\nnot found')).toBe(127);
  expect(exitCodeOf('String to replace not found')).toBeNull();
});

const outcomeText = [
  'Confirm the outcome and where it goes next',
  '## Problem',
  'Accountants re-type invoices.',
  '## Who benefits',
  'Finance staff.',
  '## Outcome',
  'Invoices download as CSV.',
  '## Out of scope',
  'Credit notes.',
  '## How we will know',
  'A month imports with no edits.',
].join('\n');

const outcomeQuestion: RunEvent = {
  kind: 'question',
  questionId: 'q-o',
  questions: [
    {
      header: 'Outcome',
      multiSelect: false,
      options: [
        {
          description: 'agree what people will see first',
          label: 'Design next (Recommended)',
        },
        {
          description: 'nothing new to see; go straight to building',
          label: 'Build next',
        },
      ],
      question: outcomeText,
    },
  ],
};

test('an answered outcome stays as its sections, and the answer drops the recommendation mark', () => {
  const items = buildThread(
    records([
      outcomeQuestion,
      {
        answers: { [outcomeText]: 'Design next (Recommended)' },
        kind: 'answer',
        questionId: 'q-o',
      },
    ]),
  );

  expect(kinds(items)).toEqual(['outcome', 'navigator']);
  expect(items[0]).toMatchObject({
    outcome: {
      sections: { Problem: 'Accountants re-type invoices.' },
      title: 'Confirm the outcome and where it goes next',
    },
  });
  expect(items[1]).toMatchObject({ text: 'Design next' });
});

test('a filed item is a line naming it, and a refused outcome move is a failure', () => {
  const items = buildThread(
    records([
      {
        input: { description: 'd', title: 'Bulk export for credit notes' },
        kind: 'tool_call',
        name: 'mcp__cerebra__create_item',
        toolCallId: 'c1',
      },
      {
        content: '{"id":"item-7","priority":null,"state":"new"}',
        isError: false,
        kind: 'tool_result',
        toolCallId: 'c1',
      },
      {
        input: {
          record: { kind: 'outcome', markdown: 'x' },
          to: 'design_ready',
        },
        kind: 'tool_call',
        name: 'mcp__cerebra__transition',
        toolCallId: 't1',
      },
      {
        content: '{"error":"refused","message":"Nothing was moved."}',
        isError: true,
        kind: 'tool_result',
        toolCallId: 't1',
      },
    ]),
  );

  expect(kinds(items)).toEqual(['filed', 'outcome_failed']);
  expect(items[0]).toMatchObject({
    itemId: 'item-7',
    title: 'Bulk export for credit notes',
  });
  expect(
    describeStep('mcp__cerebra__create_item', {
      title: 'Bulk export for credit notes',
    }),
  ).toBe('Filed “Bulk export for credit notes”');
});

test('a plan without a Decided by me heading shows its whole decisions section; empty sections are left out', () => {
  expect(
    planSectionsOf(
      [
        '## Context',
        '',
        '## Increments',
        '1. One',
        '## User-facing decisions',
        'Named after the date.',
      ].join('\n'),
    ),
  ).toEqual([
    { text: '1. One', title: 'Increments' },
    {
      text: 'Named after the date.',
      title: 'Decisions I made that the design left open',
    },
  ]);
});

test('a plan answered with changes, then revised, keeps each card in its own state', () => {
  const plan = (planId: number): RunEvent => ({
    kind: 'plan_approval',
    markdown: '## Increments\n1. One',
    planId,
  });
  const items = buildThread(
    [
      plan(1),
      { kind: 'plan_answer', planId: 1, text: 'More.', verdict: 'changes' },
      plan(2),
      plan(3),
    ].map((event, index) => ({
      createdAt: '2026-10-01T09:30:00.000Z',
      event,
      position: index + 1,
    })),
  );
  expect(
    items.map((item) =>
      item.kind === 'plan'
        ? [item.status, item.revised, item.request]
        : [item.kind],
    ),
  ).toEqual([
    ['changes', false, 'More.'],
    ['navigator'],
    ['superseded', true, null],
    ['open', true, null],
  ]);
});
