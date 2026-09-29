import type { Question } from './runner-protocol.js';

/**
 * The groomer's outcome confirmation (spec §6.3, bead cr-d8m.5): one question
 * holding the whole outcome and the two routes out of grooming. The backend
 * checks a groomer's exit against it; the UI renders it.
 */
export const outcomeSections = [
  'Problem',
  'Who benefits',
  'Outcome',
  'Out of scope',
  'How we will know',
] as const;

export type OutcomeSection = (typeof outcomeSections)[number];
export type OutcomeSections = Readonly<Record<OutcomeSection, string>>;
export type OutcomeRoute = 'design' | 'build';

export const routeChoices: Readonly<
  Record<OutcomeRoute, { readonly label: string; readonly description: string }>
> = {
  design: {
    label: 'Design next',
    description: 'agree what people will see first',
  },
  build: {
    label: 'Build next',
    description: 'nothing new to see; go straight to building',
  },
};

/** The suffix Claude's question tool asks for on the recommended option. */
export const recommendedSuffix = ' (Recommended)';

export interface OutcomeQuestion {
  readonly title: string;
  readonly sections: OutcomeSections;
  readonly recommended: OutcomeRoute | null;
}

export function stripRecommended(label: string): string {
  const trimmed = label.trim();
  return trimmed.endsWith(recommendedSuffix)
    ? trimmed.slice(0, -recommendedSuffix.length).trim()
    : trimmed;
}

export function routeOfAnswer(answer: string): OutcomeRoute | null {
  const label = stripRecommended(answer);
  if (label === routeChoices.design.label) return 'design';
  if (label === routeChoices.build.label) return 'build';
  return null;
}

/** Splits markdown on `## ` headings; null when a heading repeats. */
function sectionsOf(
  markdown: string,
): { lead: string; sections: Map<string, string> } | null {
  const lead: string[] = [];
  const bodies: { title: string; lines: string[] }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1] ?? '';
      if (bodies.some((body) => body.title === title)) return null;
      bodies.push({ title, lines: [] });
    } else {
      (bodies.at(-1)?.lines ?? lead).push(line);
    }
  }
  return {
    lead: lead.join('\n').trim(),
    sections: new Map(
      bodies.map((body) => [body.title, body.lines.join('\n').trim()]),
    ),
  };
}

function outcomeOf(sections: Map<string, string>): OutcomeSections | null {
  const result: Partial<Record<OutcomeSection, string>> = {};
  for (const name of outcomeSections) {
    const body = sections.get(name);
    if (body === undefined || body === '') return null;
    result[name] = body;
  }
  return result as OutcomeSections;
}

/** The outcome question, or null when the question is anything else. */
export function parseOutcomeQuestion(
  question: Question,
): OutcomeQuestion | null {
  if (question.multiSelect || question.options.length !== 2) return null;
  const routes = question.options.map((option) => routeOfAnswer(option.label));
  if (!routes.includes('design') || !routes.includes('build')) return null;
  const parsed = sectionsOf(question.question);
  if (parsed === null) return null;
  if (
    [...parsed.sections.keys()].some(
      (name) => !outcomeSections.includes(name as OutcomeSection),
    )
  ) {
    return null;
  }
  const sections = outcomeOf(parsed.sections);
  if (sections === null) return null;
  const marked = question.options
    .map((option, index) =>
      option.label.trim().endsWith(recommendedSuffix) ? routes[index] : null,
    )
    .filter((route): route is OutcomeRoute => route !== null);
  return {
    title: parsed.lead,
    sections,
    recommended: marked.length === 1 ? (marked[0] ?? null) : null,
  };
}

/** The five outcome sections of a record, or null when one is missing or repeated. */
export function outcomeSectionsOf(markdown: string): OutcomeSections | null {
  const parsed = sectionsOf(markdown);
  return parsed === null ? null : outcomeOf(parsed.sections);
}

const normalised = (text: string) => text.replace(/\s+/g, ' ').trim();

export function sameOutcome(a: OutcomeSections, b: OutcomeSections): boolean {
  return outcomeSections.every(
    (name) => normalised(a[name]) === normalised(b[name]),
  );
}
