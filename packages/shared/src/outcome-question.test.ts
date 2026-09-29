import { describe, expect, it } from 'vitest';

import {
  outcomeSectionsOf,
  parseOutcomeQuestion,
  routeOfAnswer,
  sameOutcome,
} from './index.js';

const text = [
  'Confirm the outcome and where it goes next',
  '',
  '## Problem',
  'Finance cannot get invoices out.',
  '## Who benefits',
  'Finance.',
  '## Outcome',
  'A CSV download.',
  '## Out of scope',
  'Credit notes.',
  '## How we will know',
  'Finance downloads one.',
].join('\n');

const question = (
  options = [
    {
      label: 'Design next (Recommended)',
      description: 'agree what people will see first',
    },
    {
      label: 'Build next',
      description: 'nothing new to see; go straight to building',
    },
  ],
  body = text,
) => ({ question: body, header: 'Outcome', multiSelect: false, options });

describe('the outcome question', () => {
  it('recognises the outcome question and its recommendation', () => {
    expect(parseOutcomeQuestion(question())).toEqual({
      title: 'Confirm the outcome and where it goes next',
      sections: {
        Problem: 'Finance cannot get invoices out.',
        'Who benefits': 'Finance.',
        Outcome: 'A CSV download.',
        'Out of scope': 'Credit notes.',
        'How we will know': 'Finance downloads one.',
      },
      recommended: 'design',
    });
    expect(
      parseOutcomeQuestion(
        question([
          { label: 'Design next', description: '' },
          { label: 'Build next (Recommended)', description: '' },
        ]),
      )?.recommended,
    ).toBe('build');
    expect(
      parseOutcomeQuestion(
        question([
          { label: 'Build next', description: '' },
          { label: 'Design next', description: '' },
        ]),
      )?.recommended,
    ).toBeNull();
  });

  it('refuses a question missing a section or with other options', () => {
    expect(
      parseOutcomeQuestion(
        question(undefined, text.replace('## Out of scope', 'Out of scope')),
      ),
    ).toBeNull();
    expect(
      parseOutcomeQuestion(question(undefined, `${text}\n## Problem\nAgain.`)),
    ).toBeNull();
    expect(
      parseOutcomeQuestion(
        question([
          { label: 'Design next', description: '' },
          { label: 'Later', description: '' },
        ]),
      ),
    ).toBeNull();
    expect(
      parseOutcomeQuestion({ ...question(), multiSelect: true }),
    ).toBeNull();
  });

  it('reads the route of an answer', () => {
    expect(routeOfAnswer('Design next')).toBe('design');
    expect(routeOfAnswer('Design next (Recommended)')).toBe('design');
    expect(routeOfAnswer(' Build next ')).toBe('build');
    expect(routeOfAnswer('Make it TSV too')).toBeNull();
  });

  it('reads the outcome sections of a record and compares them', () => {
    const record = `${text.split('\n').slice(2).join('\n')}\n## Route\nDesign next.`;
    const sections = outcomeSectionsOf(record);
    expect(sections?.Outcome).toBe('A CSV download.');
    const confirmed = parseOutcomeQuestion(question())?.sections;
    expect(confirmed && sections && sameOutcome(confirmed, sections)).toBe(
      true,
    );
    const reworded = outcomeSectionsOf(
      record.replace('A CSV download.', 'A TSV download.'),
    );
    expect(confirmed && reworded && sameOutcome(confirmed, reworded)).toBe(
      false,
    );
    const respaced = outcomeSectionsOf(
      record.replace('A CSV download.', 'A  CSV\ndownload.'),
    );
    expect(confirmed && respaced && sameOutcome(confirmed, respaced)).toBe(
      true,
    );
    expect(outcomeSectionsOf('## Problem\nOnly one.')).toBeNull();
  });
});
