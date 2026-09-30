import { expect, test } from 'vitest';

import {
  buildThread,
  describeStep,
  drawingNamed,
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

const drawingsRound = (drawingsId: string, question: string): RunEvent => ({
  drawings: [
    {
      cost: 'One click; the toolbar gets busier',
      label: 'A · Button in the toolbar',
      recommended: true,
      mockupId: 'mockup-a',
    },
    {
      cost: 'Tidy toolbar; one extra click',
      label: 'B · Inside the ⋯ menu',
      recommended: false,
      mockupId: null,
    },
  ],
  drawingsId,
  kind: 'drawings',
  question,
});

test('a round of drawings is open until answered, and a newer round supersedes it', () => {
  const items = buildThread(
    records([
      drawingsRound('d-1', 'Where should the export live?'),
      {
        choice: null,
        drawingsId: 'd-1',
        kind: 'drawings_answer',
        text: 'Make the button smaller.',
      },
      drawingsRound('d-2', 'Which of these, then?'),
      drawingsRound('d-3', 'And now?'),
      drawingsRound('d-4', 'Last one?'),
      { drawingsId: 'd-4', kind: 'drawings_withdrawn' },
      drawingsRound('d-5', 'Really the last?'),
      {
        choice: 'A · Button in the toolbar',
        drawingsId: 'd-5',
        kind: 'drawings_answer',
        text: '',
      },
    ]),
  );

  expect(kinds(items)).toEqual([
    'drawings',
    'navigator',
    'drawings',
    'drawings',
    'drawings',
    'drawings',
    'navigator',
  ]);
  expect(
    items.map((item) => (item.kind === 'drawings' ? item.status : null)),
  ).toEqual([
    'answered',
    null,
    'superseded',
    'superseded',
    'withdrawn',
    'answered',
    null,
  ]);
  expect(items[0]).toMatchObject({
    choice: null,
    drawings: [{ label: 'A · Button in the toolbar' }, { mockupId: null }],
    drawingsId: 'd-1',
    question: 'Where should the export live?',
  });
  expect(items[1]).toMatchObject({ text: 'Make the button smaller.' });
  expect(items[5]).toMatchObject({ choice: 'A · Button in the toolbar' });
  expect(items[6]).toMatchObject({ text: 'Chose A · Button in the toolbar' });

  const open = buildThread(records([drawingsRound('d-1', 'Where?')]));
  expect(open[0]).toMatchObject({ kind: 'drawings', status: 'open' });
});

const preparing = (drawingsId: string, question: string): RunEvent => ({
  count: 2,
  drawingsId,
  kind: 'drawings_preparing',
  question,
});

const showMockups = 'mcp__cerebra__show_mockups';

test('a set on its way is one round, preparing until its drawings arrive in its place', () => {
  const items = buildThread(
    records([
      drawingsRound('d-1', 'Where should the export live?'),
      {
        input: { question: 'Which of these, then?' },
        kind: 'tool_call',
        name: showMockups,
        toolCallId: 't1',
      },
      preparing('d-2', 'Which of these, then?'),
    ]),
  );
  expect(kinds(items)).toEqual(['drawings', 'drawings']);
  expect(items[0]).toMatchObject({ status: 'superseded' });
  expect(items[1]).toMatchObject({
    count: 2,
    drawings: [],
    drawingsId: 'd-2',
    question: 'Which of these, then?',
    status: 'preparing',
  });

  const shown = buildThread(
    records([
      preparing('d-2', 'Which of these, then?'),
      drawingsRound('d-2', 'Which of these, then?'),
      {
        content: '{"choice":"A · Button in the toolbar"}',
        isError: false,
        kind: 'tool_result',
        toolCallId: 't1',
      },
    ]),
  );
  expect(kinds(shown)).toEqual(['drawings']);
  expect(shown[0]).toMatchObject({
    drawings: [{ label: 'A · Button in the toolbar' }, { mockupId: null }],
    key: 'drawings-d-2',
    status: 'open',
  });
});

test('a set refused before it was shown leaves nothing in the thread', () => {
  const items = buildThread(
    records([
      { kind: 'message', text: 'Here are two ways.' },
      {
        input: { question: 'Which?' },
        kind: 'tool_call',
        name: showMockups,
        toolCallId: 't1',
      },
      preparing('d-1', 'Which?'),
      { drawingsId: 'd-1', kind: 'drawings_withdrawn' },
      {
        content: 'b.png is not a PNG image.',
        isError: true,
        kind: 'tool_result',
        toolCallId: 't1',
      },
    ]),
  );
  expect(kinds(items)).toEqual(['assistant']);
});

const designText = [
  'Confirm the agreed design',
  '## The agreed experience',
  'An "Export CSV" button sits in the toolbar.',
  '## The states',
  'Empty: disabled.',
  '## The words, exactly',
  '"Export CSV"',
  '## What was considered and rejected',
  'The ⋯ menu.',
  '## The drawing',
  'A · Button in the toolbar',
].join('\n');

test('an answered design confirmation stays as its sections, and the answer drops the recommendation mark', () => {
  const items = buildThread(
    records([
      {
        kind: 'question',
        questionId: 'q-d',
        questions: [
          {
            header: 'Design',
            multiSelect: false,
            options: [
              {
                description: 'record it',
                label: 'Confirm and send to build (Recommended)',
              },
              { description: 'say what to change', label: 'Change something' },
            ],
            question: designText,
          },
        ],
      },
      {
        answers: {
          [designText]: 'Confirm and send to build (Recommended)',
        },
        kind: 'answer',
        questionId: 'q-d',
      },
    ]),
  );

  expect(kinds(items)).toEqual(['design', 'navigator']);
  expect(items[0]).toMatchObject({
    design: {
      sections: { 'The drawing': 'A · Button in the toolbar' },
      title: 'Confirm the agreed design',
    },
  });
  expect(items[1]).toMatchObject({ text: 'Confirm and send to build' });
});

test('a refused move says which record could not be kept', () => {
  const refused = (record: string, to: string): RunEvent[] => [
    {
      input: { record: { kind: record, markdown: 'x' }, to },
      kind: 'tool_call',
      name: 'mcp__cerebra__transition',
      toolCallId: `t-${record}`,
    },
    {
      content: '{"error":"refused","message":"Nothing was moved."}',
      isError: true,
      kind: 'tool_result',
      toolCallId: `t-${record}`,
    },
  ];
  const items = buildThread(
    records([
      ...refused('outcome', 'design_ready'),
      ...refused('design', 'build_ready'),
    ]),
  );

  expect(items).toMatchObject([
    { kind: 'outcome_failed', record: 'outcome' },
    { kind: 'outcome_failed', record: 'design' },
  ]);
});

test('a design’s drawing section finds the newest round that showed it', () => {
  const items = buildThread(
    records([
      drawingsRound('d-1', 'Where?'),
      drawingsRound('d-2', 'Where, then?'),
    ]),
  );

  expect(drawingNamed(items, ' A · Button in the toolbar ')).toMatchObject({
    mockupId: 'mockup-a',
  });
  expect(
    drawingNamed(items, 'A · Button in the toolbar\nWith a smaller icon.'),
  ).toMatchObject({ label: 'A · Button in the toolbar' });
  expect(drawingNamed(items, 'Z · Nowhere')).toBeNull();
});
