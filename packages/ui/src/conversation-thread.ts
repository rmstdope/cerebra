import {
  parseOutcomeQuestion,
  stripRecommended,
  type OutcomeQuestion,
} from '@cerebra/shared';

import type { Question, RecordedEvent } from './runs';

export interface DiffLine {
  readonly kind: 'added' | 'removed' | 'same';
  readonly text: string;
}

export interface FileChange {
  readonly path: string;
  readonly lines: readonly DiffLine[];
}

export type ThreadItem =
  | {
      readonly kind: 'navigator' | 'assistant';
      readonly key: string;
      readonly text: string;
      readonly at: string;
    }
  | StepItem
  | HelperItem
  | {
      /** The groomer's outcome, as the navigator answered it. */
      readonly kind: 'outcome';
      readonly key: string;
      readonly at: string;
      readonly outcome: OutcomeQuestion;
    }
  | {
      /** An item an agent filed, from a create_item that succeeded. */
      readonly kind: 'filed';
      readonly key: string;
      readonly itemId: string;
      readonly title: string;
    }
  | {
      /** A groomer's move out of grooming that the backend refused. */
      readonly kind: 'outcome_failed';
      readonly key: string;
    }
  | PlanItem;

/** One section of a plan card, under the card's own heading. */
export interface PlanSection {
  readonly title: string;
  readonly text: string;
}

/**
 * A builder's plan at the plan checkpoint (spec §4.9). `open` waits for an answer; `superseded`
 * was replaced by a newer plan before it was answered.
 */
export interface PlanItem {
  readonly kind: 'plan';
  readonly key: string;
  readonly at: string;
  readonly planId: number;
  readonly revised: boolean;
  readonly sections: readonly PlanSection[];
  status: 'open' | 'superseded' | 'approved' | 'changes';
  request: string | null;
}

/** Where each card section comes from in the plan record (spec §3). */
const planSources: readonly {
  readonly title: string;
  readonly heading: string;
  readonly sub?: string;
}[] = [
  { heading: 'Files to change, and what to reuse', title: 'Files to change' },
  { heading: 'Context', title: 'What’s new' },
  { heading: 'Increments', title: 'Increments' },
  {
    heading: 'User-facing decisions',
    sub: 'Decided by me',
    title: 'Decisions I made that the design left open',
  },
];

function headed(text: string, marker: string): Map<string, string> {
  const found = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  const close = () => {
    if (current !== null) found.set(current, lines.join('\n').trim());
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(`${marker} `)) {
      close();
      current = line.slice(marker.length + 1).trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  close();
  return found;
}

/** The plan card's sections, in the card's order; an empty section is left out. */
export function planSectionsOf(markdown: string): PlanSection[] {
  const sections = headed(markdown, '##');
  return planSources.flatMap(({ heading, sub, title }) => {
    const body = sections.get(heading) ?? '';
    const subs = sub === undefined ? null : headed(body, '###');
    const text =
      subs === null || subs.size === 0 ? body : (subs.get(sub!) ?? '');
    return text === '' ? [] : [{ text, title }];
  });
}

const createItem = 'mcp__cerebra__create_item';
const transition = 'mcp__cerebra__transition';

function isOutcomeMove(step: StepItem): boolean {
  if (step.name !== transition) return false;
  const to = field(step.input, 'to');
  return to === 'design_ready' || to === 'build_ready';
}

function filedIdOf(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return field(parsed, 'id');
  } catch {
    return null;
  }
}

/** Whether a step is an outcome move; its success is the result it settled with, null while running. */
export function outcomeMoveOf(item: ThreadItem): boolean | null {
  if (item.kind === 'outcome_failed') return false;
  if (item.kind !== 'step' || !isOutcomeMove(item)) return null;
  return item.result === null ? null : !item.result.isError;
}

export interface StepItem {
  readonly kind: 'step';
  readonly key: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  result: { readonly content: string; readonly isError: boolean } | null;
}

export interface HelperItem {
  readonly kind: 'helper';
  readonly key: string;
  readonly toolCallId: string;
  readonly task: string;
  end: { readonly isError: boolean } | null;
  readonly items: ThreadItem[];
}

/** Arranges a run's recorded events into the one thread: messages, steps and nested helpers. */
export function buildThread(events: readonly RecordedEvent[]): ThreadItem[] {
  const root: ThreadItem[] = [];
  const helpers = new Map<string, HelperItem>();
  const steps = new Map<string, { step: StepItem; in: ThreadItem[] }>();
  const questions = new Map<string, readonly Question[]>();
  const plans = new Map<number, PlanItem>();
  let lastPlan: PlanItem | null = null;

  for (const record of events) {
    const { event } = record;
    const parent = event.parentToolCallId;
    const target =
      (parent === undefined ? undefined : helpers.get(parent)?.items) ?? root;
    const key = String(record.position);
    const at = record.createdAt;
    switch (event.kind) {
      case 'user_message':
        target.push({ at, key, kind: 'navigator', text: event.text });
        break;
      case 'message':
        target.push({ at, key, kind: 'assistant', text: event.text });
        break;
      case 'tool_call': {
        const step: StepItem = {
          input: event.input,
          key: `step-${event.toolCallId}`,
          kind: 'step',
          name: event.name,
          result: null,
          toolCallId: event.toolCallId,
        };
        steps.set(event.toolCallId, { in: target, step });
        target.push(step);
        break;
      }
      case 'tool_result': {
        const found = steps.get(event.toolCallId);
        if (found === undefined) break;
        const { step } = found;
        step.result = { content: event.content, isError: event.isError };
        const replacement = settled(step);
        if (replacement !== null) {
          found.in.splice(found.in.indexOf(step), 1, replacement);
        }
        break;
      }
      case 'subagent_start': {
        const helper: HelperItem = {
          end: null,
          items: [],
          key: `helper-${event.toolCallId}`,
          kind: 'helper',
          task: event.description || event.subagentType,
          toolCallId: event.toolCallId,
        };
        helpers.set(event.toolCallId, helper);
        target.push(helper);
        break;
      }
      case 'subagent_end': {
        const helper = helpers.get(event.toolCallId);
        if (helper !== undefined) helper.end = { isError: event.isError };
        break;
      }
      case 'plan_approval': {
        if (lastPlan?.status === 'open') lastPlan.status = 'superseded';
        const plan: PlanItem = {
          at,
          key: `plan-${event.planId}`,
          kind: 'plan',
          planId: event.planId,
          request: null,
          revised: lastPlan !== null,
          sections: planSectionsOf(event.markdown),
          status: 'open',
        };
        plans.set(event.planId, plan);
        lastPlan = plan;
        root.push(plan);
        break;
      }
      case 'plan_answer': {
        const plan = plans.get(event.planId);
        if (plan !== undefined) {
          plan.status = event.verdict;
          plan.request = event.verdict === 'changes' ? event.text : null;
        }
        root.push({
          at,
          key,
          kind: 'navigator',
          text: event.verdict === 'approved' ? 'Plan approved.' : event.text,
        });
        break;
      }
      case 'question':
        questions.set(event.questionId, event.questions);
        break;
      case 'answer': {
        const asked = questions.get(event.questionId) ?? [];
        const outcome =
          asked.length === 1 && asked[0] !== undefined
            ? parseOutcomeQuestion(asked[0])
            : null;
        if (outcome !== null) {
          target.push({ at, key: `${key}-outcome`, kind: 'outcome', outcome });
          target.push({
            at,
            key,
            kind: 'navigator',
            text: stripRecommended(Object.values(event.answers).join(', ')),
          });
          break;
        }
        for (const question of asked) {
          target.push({
            at,
            key: `${key}-q-${question.question}`,
            kind: 'assistant',
            text: question.question,
          });
        }
        target.push({
          at,
          key,
          kind: 'navigator',
          text: Object.values(event.answers).join(', '),
        });
        break;
      }
      default:
        break;
    }
  }
  return root;
}

function settled(step: StepItem): ThreadItem | null {
  if (step.result === null) return null;
  if (step.name === createItem && !step.result.isError) {
    const itemId = filedIdOf(step.result.content);
    const title = field(step.input, 'title');
    return itemId === null || title === null
      ? null
      : { itemId, key: step.key, kind: 'filed', title };
  }
  if (isOutcomeMove(step) && step.result.isError) {
    return { key: step.key, kind: 'outcome_failed' };
  }
  return null;
}

/** How many steps a helper took itself; a helper it started counts as one. */
export function stepCountOf(helper: HelperItem): number {
  return helper.items.filter(
    (item) =>
      item.kind === 'step' ||
      item.kind === 'helper' ||
      item.kind === 'filed' ||
      item.kind === 'outcome_failed',
  ).length;
}

function field(input: unknown, name: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function describeStep(name: string, input: unknown): string {
  const path = field(input, 'file_path');
  const pattern = field(input, 'pattern');
  switch (name) {
    case 'Bash': {
      const command = field(input, 'command')?.split('\n')[0]?.trim();
      return command ? `Ran ${command}` : `Used ${name}`;
    }
    case 'Read':
      return path === null ? `Used ${name}` : `Read ${path}`;
    case 'Edit':
    case 'MultiEdit':
      return path === null ? `Used ${name}` : `Edited ${path}`;
    case 'Write':
      return path === null ? `Used ${name}` : `Wrote ${path}`;
    case 'Grep':
      return pattern === null ? `Used ${name}` : `Searched “${pattern}”`;
    case 'Glob':
      return pattern === null
        ? `Used ${name}`
        : `Found files matching “${pattern}”`;
    case 'WebFetch': {
      const url = field(input, 'url');
      return url === null ? `Used ${name}` : `Fetched ${url}`;
    }
    case 'WebSearch': {
      const query = field(input, 'query');
      return query === null
        ? `Used ${name}`
        : `Searched the web for “${query}”`;
    }
    case createItem: {
      const title = field(input, 'title');
      return title === null ? `Used ${name}` : `Filed “${title}”`;
    }
    case 'TodoWrite':
      return 'Updated the to-do list';
    default:
      return `Used ${name}`;
  }
}

function linesOf(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

const diffLimit = 400;

/** A line diff by longest common subsequence; past `diffLimit` lines a side, all removed then all added. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > diffLimit || b.length > diffLimit) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'removed', text })),
      ...b.map((text): DiffLine => ({ kind: 'added', text })),
    ];
  }
  const width = b.length + 1;
  const common = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1]! + 1
          : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j >= b.length ||
        common[(i + 1) * width + j]! >= common[i * width + j + 1]!)
    ) {
      lines.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      lines.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  return lines;
}

function editOf(value: unknown): DiffLine[] | null {
  const before = field(value, 'old_string') ?? '';
  const after = field(value, 'new_string');
  return after === null && before === '' ? null : lineDiff(before, after ?? '');
}

/** The change a step makes to a file, when it is one. */
export function fileChangeOf(name: string, input: unknown): FileChange | null {
  const path = field(input, 'file_path');
  if (path === null) return null;
  if (name === 'Edit') {
    const lines = editOf(input);
    return lines === null ? null : { lines, path };
  }
  if (name === 'MultiEdit') {
    const edits = (input as { edits?: unknown }).edits;
    if (!Array.isArray(edits)) return null;
    return { lines: edits.flatMap((edit) => editOf(edit) ?? []), path };
  }
  if (name === 'Write') {
    const content =
      typeof (input as { content?: unknown }).content === 'string'
        ? (input as { content: string }).content
        : '';
    return {
      lines: linesOf(content).map((text) => ({ kind: 'added', text })),
      path,
    };
  }
  return null;
}

export function exitCodeOf(content: string): number | null {
  const match = /^(?:Error: )?Exit code (\d+)/m.exec(content);
  return match === null ? null : Number(match[1]);
}
