import {
  normalised,
  sectionsOf,
  stripRecommended,
} from './outcome-question.js';
import type { Question } from './runner-protocol.js';

/**
 * The designer's confirmation of the agreed experience (spec §6.3, bead cr-cq8.1): one question
 * holding the whole write-up. The backend checks a designer's exit against it; the UI renders it.
 */
export const designSections = [
  'The agreed experience',
  'The states',
  'The words, exactly',
  'What was considered and rejected',
  'The drawing',
] as const;

export type DesignSection = (typeof designSections)[number];
export type DesignSections = Readonly<Record<DesignSection, string>>;

export const confirmDesignTitle = 'Confirm the agreed experience';
export const confirmDesignLabel = 'Looks right — hand it to building';
/** Claude's question tool needs two options; the UI offers this one as its free-text row. */
export const changeDesignLabel = 'Change something';

export interface DesignQuestion {
  readonly title: string;
  readonly sections: DesignSections;
}

export function confirmsDesign(answer: string): boolean {
  return stripRecommended(answer) === confirmDesignLabel;
}

function designOf(sections: Map<string, string>): DesignSections | null {
  const result: Partial<Record<DesignSection, string>> = {};
  for (const name of designSections) {
    const body = sections.get(name);
    if (body === undefined || body === '') return null;
    result[name] = body;
  }
  return result as DesignSections;
}

/** The design confirmation, or null when the question is anything else. */
export function parseDesignQuestion(question: Question): DesignQuestion | null {
  if (question.multiSelect || question.options.length !== 2) return null;
  const labels = question.options.map((option) =>
    stripRecommended(option.label),
  );
  if (
    !labels.includes(confirmDesignLabel) ||
    !labels.includes(changeDesignLabel)
  ) {
    return null;
  }
  const parsed = sectionsOf(question.question);
  if (
    parsed === null ||
    [...parsed.sections.keys()].some(
      (name) => !designSections.includes(name as DesignSection),
    )
  ) {
    return null;
  }
  const sections = designOf(parsed.sections);
  return sections === null ? null : { title: parsed.lead, sections };
}

/** A design record's sections (spec §4.11), its "The mockup" read as the confirmation's "The drawing". */
export function designRecordSectionsOf(
  markdown: string,
): DesignSections | null {
  const parsed = sectionsOf(markdown);
  if (parsed === null) return null;
  const sections = new Map(parsed.sections);
  // The record names its drawing once, as the mockup; a second name could disagree with it.
  if (sections.has('The drawing')) return null;
  const mockup = sections.get('The mockup');
  sections.delete('The mockup');
  if (mockup !== undefined) sections.set('The drawing', mockup);
  return designOf(sections);
}

export function sameDesign(a: DesignSections, b: DesignSections): boolean {
  return designSections.every(
    (name) => normalised(a[name]) === normalised(b[name]),
  );
}
