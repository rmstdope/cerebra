import { describe, expect, it } from 'vitest';

import {
  changeDesignLabel,
  confirmDesignLabel,
  confirmsDesign,
  confirmDesignTitle,
  designRecordSectionsOf,
  namesDrawing,
  parseDesignQuestion,
  sameDesign,
} from './index.js';

const sections = [
  '## The agreed experience',
  'An "Export CSV" button sits in the invoice toolbar.',
  '## The states',
  'Empty list: button disabled with "Nothing to export".',
  '## The words, exactly',
  '"Export CSV"; "Nothing to export"',
  '## What was considered and rejected',
  'Export inside the ⋯ menu: one extra click.',
];

const text = [
  'Confirm the agreed design',
  '',
  ...sections,
  '## The drawing',
  'A · Button in the toolbar',
].join('\n');

const options = [
  { label: confirmDesignLabel, description: 'record it and send it on' },
  { label: changeDesignLabel, description: 'say what to change' },
];

const question = (body = text, choices = options) => ({
  question: body,
  header: 'Design',
  multiSelect: false,
  options: choices,
});

const expected = {
  'The agreed experience':
    'An "Export CSV" button sits in the invoice toolbar.',
  'The states': 'Empty list: button disabled with "Nothing to export".',
  'The words, exactly': '"Export CSV"; "Nothing to export"',
  'What was considered and rejected':
    'Export inside the ⋯ menu: one extra click.',
  'The drawing': 'A · Button in the toolbar',
};

describe('the design confirmation', () => {
  it('recognises the design confirmation and its sections', () => {
    expect(parseDesignQuestion(question())).toEqual({
      title: 'Confirm the agreed design',
      sections: expected,
    });
    expect(
      parseDesignQuestion(
        question(text, [
          { ...options[0]!, label: `${confirmDesignLabel} (Recommended)` },
          options[1]!,
        ]),
      ),
    ).not.toBeNull();
  });

  it('refuses a question missing a section, with another heading, or other options', () => {
    expect(
      parseDesignQuestion(question(text.replace('## The states', '## States'))),
    ).toBeNull();
    expect(
      parseDesignQuestion(question(`${text}\n## Notes\nMore.`)),
    ).toBeNull();
    expect(
      parseDesignQuestion(
        question(text.replace('A · Button in the toolbar', '')),
      ),
    ).toBeNull();
    expect(
      parseDesignQuestion(
        question(text, [options[0]!, { label: 'Other', description: '' }]),
      ),
    ).toBeNull();
    expect(
      parseDesignQuestion({ ...question(), multiSelect: true }),
    ).toBeNull();
  });

  it('words the confirmation as the agreed design, sent to build', () => {
    expect(confirmDesignTitle).toBe('Confirm the agreed design');
    expect(confirmDesignLabel).toBe('Confirm and send to build');
    expect(changeDesignLabel).toBe('Change something');
  });

  it('matches a drawing section to the drawing it names', () => {
    const label = 'A · Button in the toolbar';
    expect(namesDrawing(' A · Button in the toolbar ', label)).toBe(true);
    expect(namesDrawing(`${label}\nWith a smaller icon.`, label)).toBe(true);
    expect(namesDrawing(`${label} and more`, label)).toBe(false);
    expect(namesDrawing('B · Inside the menu', label)).toBe(false);
    expect(namesDrawing('', label)).toBe(false);
  });

  it('reads a confirmation from an answer', () => {
    expect(confirmsDesign(confirmDesignLabel)).toBe(true);
    expect(confirmsDesign(`${confirmDesignLabel} (Recommended)`)).toBe(true);
    expect(confirmsDesign(changeDesignLabel)).toBe(false);
    expect(confirmsDesign('Make the button blue.')).toBe(false);
  });

  it('reads a design record’s mockup as the drawing', () => {
    const record = [
      ...sections,
      '## The mockup',
      'A · Button in the toolbar',
    ].join('\n');
    const read = designRecordSectionsOf(record);
    expect(read).toEqual(expected);
    expect(sameDesign(read!, parseDesignQuestion(question())!.sections)).toBe(
      true,
    );
    expect(designRecordSectionsOf(sections.join('\n'))).toBeNull();
    expect(
      designRecordSectionsOf(
        [
          ...sections,
          '## The drawing',
          'B · Inside the menu',
          '## The mockup',
          'A · Button in the toolbar',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('compares designs with whitespace aside', () => {
    const spaced = {
      ...expected,
      'The states': 'Empty list:\n  button disabled with "Nothing to export".',
    };
    expect(sameDesign(expected, spaced)).toBe(true);
    expect(
      sameDesign(expected, {
        ...expected,
        'The drawing': 'B · Inside the menu',
      }),
    ).toBe(false);
  });
});
