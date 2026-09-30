import {
  confirmsDesign,
  designRecordSectionsOf,
  outcomeSectionsOf,
  parseDesignQuestion,
  parseOutcomeQuestion,
  routeChoices,
  maxFetchPaths,
  routeOfAnswer,
  sameDesign,
  sameOutcome,
  type AgentEvent,
  type Drawing,
  type RunFile,
  type Question,
  type OutcomeRoute,
} from '@cerebra/shared';
import { sql, type Kysely } from 'kysely';

import {
  WorkItemNotFoundError,
  recordForHeldItem,
  transitionLocked,
  type Board,
  type BoardQuery,
} from './board.js';
import { liveRunStates, workItemTypes, type Database } from './database.js';
import {
  queueFor,
  recordProblem,
  workItemStates,
  type Priority,
  type WorkItemState,
} from './lifecycle.js';
import type { DrawingQuestions } from './drawings.js';
import {
  drawingContentProblem,
  drawingTypeOf,
  type MockupContentType,
  type MockupStore,
} from './mockups.js';
import type { PlanApprovals } from './plan-approvals.js';
import { isUuid } from './runs.js';
import { FileRequestError } from './supervisor.js';

type RunRole = Database['runs']['role'];

/** The live run behind an MCP call, and what its agent type may do (spec §6.3). */
export interface ToolCaller {
  readonly agentName: string | null;
  readonly projectId: string;
  readonly role: RunRole;
  readonly runId: string;
  readonly tools: readonly string[];
}

export interface ToolDescriptor {
  readonly description: string;
  readonly inputSchema: {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly type: 'object';
  };
  readonly name: string;
}

export type ToolRefusalCode =
  | 'invalid_arguments'
  | 'not_found'
  | 'nothing_held'
  | 'other_project'
  | 'refused'
  | 'tool_not_allowed'
  | 'unknown_tool';

export type ToolOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly code: ToolRefusalCode;
      readonly message: string;
      readonly ok: false;
    };

export interface BoardTools {
  list(caller: ToolCaller): readonly ToolDescriptor[];
  /** `signal` is aborted when the caller gives up on the call, so a waiting tool can stop. */
  call(
    caller: ToolCaller,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolOutcome>;
}

/** Answers the live run a token hash belongs to, or `null` for an ended or unknown one. */
export async function resolveCaller(
  database: Kysely<Database>,
  tokenHash: string,
): Promise<ToolCaller | null> {
  const row = await database
    .selectFrom('runs')
    .innerJoin('agents', 'agents.id', 'runs.agent_id')
    .innerJoin('agent_types', 'agent_types.id', 'agents.agent_type_id')
    .select([
      'runs.id',
      'runs.agent_name',
      'runs.project_id',
      'runs.role',
      'agent_types.definition',
    ])
    .where('runs.token_hash', '=', tokenHash)
    .where('runs.status', 'in', liveRunStates)
    .executeTakeFirst();
  if (row === undefined || row.project_id === null) {
    return null;
  }
  return {
    agentName: row.agent_name,
    projectId: row.project_id,
    role: row.role,
    runId: row.id,
    tools: allowedTools(row.definition),
  };
}

function allowedTools(definition: unknown): readonly string[] {
  const parsed: unknown =
    typeof definition === 'string' ? JSON.parse(definition) : definition;
  const tools =
    typeof parsed === 'object' && parsed !== null && 'tools' in parsed
      ? parsed.tools
      : [];
  return Array.isArray(tools)
    ? tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
}

class Refusal extends Error {
  constructor(
    readonly code: ToolRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

type Arguments = Readonly<Record<string, unknown>>;

interface Tool {
  readonly descriptor: ToolDescriptor;
  run(
    caller: ToolCaller,
    args: Arguments,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const priorities: readonly Priority[] = ['P0', 'P1', 'P2', 'P3'];

const routeStates: Readonly<Record<OutcomeRoute, WorkItemState>> = {
  build: 'build_ready',
  design: 'design_ready',
};

export function createBoardTools({
  board,
  database,
  drawings,
  fetchFiles,
  mockups,
  onReleased,
  plans,
}: {
  readonly board: Board;
  readonly database: Kysely<Database>;
  /** Where a designer's round of drawings waits for the navigator (spec §6.3). */
  readonly drawings?: DrawingQuestions;
  /** Reads files from a live run's checkout, through its runner (architecture §5.2). */
  readonly fetchFiles?: (
    runId: string,
    paths: readonly string[],
  ) => Promise<readonly RunFile[]>;
  /** Where published drawings are kept (architecture §11). */
  readonly mockups?: Pick<MockupStore, 'save'>;
  /** Told when a call leaves the calling run holding nothing, so it can finish (architecture §5.3). */
  readonly onReleased?: (runId: string) => void;
  /** Where a plan waits for the navigator's approval; without it no plan waits (spec §4.9). */
  readonly plans?: PlanApprovals;
}): BoardTools {
  async function itemInProject(
    caller: ToolCaller,
    itemId: string,
  ): Promise<string> {
    const row = isUuid(itemId)
      ? await database
          .selectFrom('work_items')
          .select('project_id')
          .where('id', '=', itemId)
          .executeTakeFirst()
      : undefined;
    if (row === undefined) {
      throw new Refusal('not_found', `Work item ${itemId} does not exist.`);
    }
    if (row.project_id !== caller.projectId) {
      throw new Refusal(
        'other_project',
        `Work item ${itemId} belongs to another project.`,
      );
    }
    return itemId;
  }

  async function heldItem(caller: ToolCaller): Promise<string | null> {
    const row = await database
      .selectFrom('work_items')
      .select('id')
      .where('holder_run_id', '=', caller.runId)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async function requireHeld(caller: ToolCaller): Promise<string> {
    const held = await heldItem(caller);
    if (held === null) {
      throw new Refusal('nothing_held', 'This run holds no work item.');
    }
    return held;
  }

  /** Applies a request to the held item, re-checking under the row lock that the run holds it. */
  async function moveHeld(
    caller: ToolCaller,
    build: (state: WorkItemState) => Parameters<typeof board.transition>[1],
  ): Promise<{ readonly id: string; readonly state: WorkItemState }> {
    const itemId = await requireHeld(caller);
    const nothingHeld = {
      ok: false as const,
      reason: 'This run no longer holds its work item.',
      held: false,
    };
    const result = await transitionLocked(database, itemId, ({ item }) =>
      item.holderRunId === caller.runId ? build(item.state) : nothingHeld,
    );
    if (!result.ok) {
      throw new Refusal(
        'held' in result ? 'nothing_held' : 'refused',
        result.reason,
      );
    }
    if (result.item.holderRunId !== caller.runId) {
      onReleased?.(caller.runId);
    }
    return { id: itemId, state: result.item.state };
  }

  /**
   * The newest question of the run that `parse` recognises, with the navigator's answer to it
   * when there is one; null when the run never asked it.
   */
  async function newestAsked<T>(
    caller: ToolCaller,
    parse: (question: Question) => T | null,
  ): Promise<{ readonly parsed: T; readonly answer?: string } | null> {
    const rows = await database
      .selectFrom('run_events')
      .select('event')
      .where('run_id', '=', caller.runId)
      .where(sql<string>`event->>'kind'`, 'in', ['question', 'answer'])
      .orderBy('position', 'asc')
      .execute();
    const events = rows.map((row) => row.event as AgentEvent);
    let asked: { questionId: string; text: string; parsed: T } | null = null;
    for (const event of events) {
      if (event.kind !== 'question') continue;
      for (const question of event.questions) {
        const parsed = parse(question);
        if (parsed !== null) {
          asked = {
            parsed,
            questionId: event.questionId,
            text: question.question,
          };
        }
      }
    }
    if (asked === null) return null;
    const { questionId, text } = asked;
    const answer = events.find(
      (event) => event.kind === 'answer' && event.questionId === questionId,
    );
    const chosen = answer?.kind === 'answer' ? answer.answers[text] : undefined;
    return chosen === undefined
      ? { parsed: asked.parsed }
      : { answer: chosen, parsed: asked.parsed };
  }

  const nothingMoved = 'Nothing was moved.';

  /**
   * A groomer leaves grooming only on the outcome and route the navigator
   * confirmed in the run's newest outcome question (spec §6.3).
   */
  async function requireConfirmed(
    caller: ToolCaller,
    to: WorkItemState,
    record: Arguments | undefined,
  ): Promise<void> {
    const markdown =
      record?.kind === 'outcome' && typeof record.markdown === 'string'
        ? record.markdown
        : null;
    const recorded = markdown === null ? null : outcomeSectionsOf(markdown);
    if (recorded === null) {
      // The lifecycle refuses a missing or malformed outcome record itself.
      return;
    }
    const asked = await newestAsked(caller, parseOutcomeQuestion);
    if (asked === null) {
      throw new Refusal(
        'refused',
        `Ask the navigator to confirm the outcome and its route with the outcome question before recording it. ${nothingMoved}`,
      );
    }
    if (asked.answer === undefined) {
      throw new Refusal(
        'refused',
        `The navigator has not answered the outcome question yet. ${nothingMoved}`,
      );
    }
    const route = routeOfAnswer(asked.answer);
    if (route === null) {
      throw new Refusal(
        'refused',
        `The navigator answered the outcome question with a change, not a route: apply it, say "Updated. Here it is again." and ask the whole question again. ${nothingMoved}`,
      );
    }
    if (routeStates[route] !== to) {
      throw new Refusal(
        'refused',
        `The navigator chose ${routeChoices[route].label}, so the item moves to ${routeStates[route]}. ${nothingMoved}`,
      );
    }
    if (!sameOutcome(asked.parsed.sections, recorded)) {
      throw new Refusal(
        'refused',
        `The outcome record differs from the outcome the navigator confirmed; record the confirmed sections word for word. ${nothingMoved}`,
      );
    }
  }

  /**
   * A designer leaves design only on the experience the navigator confirmed in the run's newest
   * design confirmation (spec §6.3).
   */
  async function requireDesignConfirmed(
    caller: ToolCaller,
    record: Arguments | undefined,
  ): Promise<void> {
    const markdown =
      record?.kind === 'design' && typeof record.markdown === 'string'
        ? record.markdown
        : null;
    const recorded =
      markdown === null ? null : designRecordSectionsOf(markdown);
    if (recorded === null) {
      // The lifecycle refuses a missing or malformed design record itself.
      return;
    }
    const asked = await newestAsked(caller, parseDesignQuestion);
    if (asked === null) {
      throw new Refusal(
        'refused',
        `Ask the navigator to confirm the agreed experience with the design confirmation before recording it. ${nothingMoved}`,
      );
    }
    if (asked.answer === undefined) {
      throw new Refusal(
        'refused',
        `The navigator has not answered the design confirmation yet. ${nothingMoved}`,
      );
    }
    if (!confirmsDesign(asked.answer)) {
      throw new Refusal(
        'refused',
        `The navigator answered the design confirmation with a change: apply it, say "Updated. Here it is again." and ask the whole question again. ${nothingMoved}`,
      );
    }
    if (!sameDesign(asked.parsed.sections, recorded)) {
      throw new Refusal(
        'refused',
        `The design record differs from the experience the navigator confirmed; record the confirmed sections word for word, the drawing under ## The mockup. ${nothingMoved}`,
      );
    }
  }

  /** Appends a builder's record to the item it holds while building (spec §4.11). */
  async function recordHeld(
    caller: ToolCaller,
    record: Readonly<Record<string, unknown>> & { readonly kind: string },
  ): Promise<{
    readonly id: string;
    readonly recorded: string;
    readonly recordId: number;
  }> {
    const itemId = await requireHeld(caller);
    const result = await recordForHeldItem(
      database,
      itemId,
      caller.runId,
      record,
    );
    if (!result.ok) {
      throw new Refusal(result.code, result.reason);
    }
    return { id: itemId, recordId: result.recordId, recorded: record.kind };
  }

  /** Whether the caller's project has the navigator approve plans (spec §4.9). */
  async function plansNeedApproval(caller: ToolCaller): Promise<boolean> {
    if (plans === undefined) return false;
    const project = await database
      .selectFrom('projects')
      .select('involvement')
      .where('id', '=', caller.projectId)
      .executeTakeFirst();
    return project?.involvement === 'plan' || project?.involvement === 'full';
  }

  /**
   * A builder's pull request is the held item's: its branch is named after the item's key and it
   * is opened in the project's repository (spec §4.11, §8).
   */
  async function requireLinkedPullRequest(
    caller: ToolCaller,
    record: Arguments | undefined,
  ): Promise<void> {
    if (record?.kind !== 'pull_request') {
      // The lifecycle refuses a missing record itself.
      return;
    }
    const itemId = await requireHeld(caller);
    const row = await database
      .selectFrom('work_items')
      .innerJoin('projects', 'projects.id', 'work_items.project_id')
      .select(['work_items.key', 'projects.remote'])
      .where('work_items.id', '=', itemId)
      .executeTakeFirstOrThrow();
    const nothingMoved = 'Nothing was moved.';
    const key = row.key.toLowerCase();
    const branch =
      typeof record.branch === 'string' ? record.branch.toLowerCase() : '';
    if (branch !== key && !branch.startsWith(`${key}-`)) {
      throw new Refusal(
        'refused',
        `The branch must be named after ${row.key}: ${row.key} or ${row.key}-<short-description>. ${nothingMoved}`,
      );
    }
    const repository = repositoryOf(row.remote);
    if (repository === null) {
      throw new Refusal(
        'refused',
        `This project's repository is not on GitHub, so its pull request cannot be linked. ${nothingMoved}`,
      );
    }
    const url = typeof record.url === 'string' ? record.url : '';
    // A URL this does not match is refused by the lifecycle's own pull_request check.
    const pulled =
      /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+$/.exec(url)?.[1];
    if (
      pulled !== undefined &&
      pulled.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new Refusal(
        'refused',
        `The pull request must be in ${repository}, this project's repository. ${nothingMoved}`,
      );
    }
  }

  const tools: Record<string, Tool> = {
    get_item: {
      descriptor: {
        name: 'get_item',
        description:
          'Read one work item of this project: its fields, comments, records, history and who filed it. Without item_id, reads the item this run holds.',
        inputSchema: {
          type: 'object',
          properties: { item_id: { type: 'string' } },
        },
      },
      async run(caller, args) {
        const named = optionalText(args, 'item_id');
        const itemId =
          named === undefined
            ? await requireHeld(caller)
            : await itemInProject(caller, named);
        const [item, comments, records, history, provenance] =
          await Promise.all([
            board.getWorkItem(itemId),
            board.listComments(itemId),
            board.listRecords(itemId),
            board.getHistory(itemId),
            board.getProvenance(itemId),
          ]);
        return { comments, history, item, provenance, records };
      },
    },
    list_items: {
      descriptor: {
        name: 'list_items',
        description:
          'List this project’s work items, optionally filtered by state, priority or text.',
        inputSchema: {
          type: 'object',
          properties: {
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            priority: { enum: [...priorities, 'none'] },
            search: { type: 'string' },
            state: { enum: [...workItemStates] },
          },
        },
      },
      async run(caller, args) {
        const query: BoardQuery = {
          cursor: optionalText(args, 'cursor'),
          limit: optionalLimit(args),
          priority: optionalOneOf(args, 'priority', [...priorities, 'none']),
          search: optionalText(args, 'search'),
          state: optionalOneOf(args, 'state', workItemStates),
        };
        return board.listWorkItems(caller.projectId, query);
      },
    },
    create_item: {
      descriptor: {
        name: 'create_item',
        description:
          'File a new work item in this project. It lands in new, unranked, for the navigator to triage.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            title: { type: 'string', minLength: 1 },
            type: { enum: [...workItemTypes] },
          },
          required: ['title'],
        },
      },
      async run(caller, args) {
        const title = text(args, 'title').trim();
        if (title === '') {
          throw invalid('title must not be empty.');
        }
        const type = optionalOneOf(args, 'type', workItemTypes);
        const id = crypto.randomUUID();
        const discoveredFromId = await heldItem(caller);
        await board.createWorkItem({
          description: optionalText(args, 'description') ?? '',
          discoveredFromId: discoveredFromId ?? undefined,
          filedByRunId: caller.runId,
          id,
          projectId: caller.projectId,
          title,
          type,
        });
        return { id, priority: null, state: 'new' };
      },
    },
    comment: {
      descriptor: {
        name: 'comment',
        description:
          'Comment on the work item this run holds, or on another item of this project named by item_id.',
        inputSchema: {
          type: 'object',
          properties: {
            body: { type: 'string', minLength: 1 },
            item_id: { type: 'string' },
          },
          required: ['body'],
        },
      },
      async run(caller, args) {
        const body = text(args, 'body');
        if (body.trim() === '') {
          throw invalid('body must not be empty.');
        }
        const named = optionalText(args, 'item_id');
        const itemId =
          named === undefined
            ? await requireHeld(caller)
            : await itemInProject(caller, named);
        const comment = await board.addComment(itemId, body);
        return { id: comment.id, itemId };
      },
    },
    transition: {
      descriptor: {
        name: 'transition',
        description:
          'Move the work item this run holds to another state, with the record or reason that move needs.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            record: { type: 'object' },
            to: { enum: [...workItemStates] },
          },
          required: ['to'],
        },
      },
      async run(caller, args) {
        const to = oneOf(args, 'to', workItemStates);
        const reason = optionalText(args, 'reason');
        const record = args.record;
        if (
          record !== undefined &&
          (typeof record !== 'object' ||
            record === null ||
            Array.isArray(record))
        ) {
          throw invalid('record must be an object.');
        }
        const leavesGrooming =
          caller.role === 'groomer' &&
          (to === 'design_ready' || to === 'build_ready');
        const leavesDesign = caller.role === 'designer' && to === 'build_ready';
        if (leavesGrooming) {
          await requireHeld(caller);
          await requireConfirmed(caller, to, record as Arguments | undefined);
        }
        if (leavesDesign) {
          await requireHeld(caller);
          await requireDesignConfirmed(caller, record as Arguments | undefined);
        }
        if (caller.role === 'builder' && to === 'review_ready') {
          await requireLinkedPullRequest(
            caller,
            record as Arguments | undefined,
          );
        }
        const moved = await moveHeld(caller, () => ({
          actor: { role: caller.role, runId: caller.runId },
          reason,
          record: record as Arguments | undefined,
          to,
        }));
        if (!leavesGrooming && !leavesDesign) {
          return moved;
        }
        const { title } = await board.getWorkItem(moved.id);
        const waitsFor = to === 'design_ready' ? 'design' : 'build';
        return {
          ...moved,
          message: `Recorded. ${title} now waits for ${waitsFor}.`,
        };
      },
    },
    submit_plan: {
      descriptor: {
        name: 'submit_plan',
        description:
          'Record the plan for the item this run is building, before writing any code: Markdown under the plan record’s ## headings (Context; Files to change, and what to reuse; Increments; The test plan; User-facing decisions; Out of scope; Validation; Known traps). When the project has the navigator approve plans, the call waits for their answer: build on approved; when they ask for changes, revise the plan and submit it again.',
        inputSchema: {
          type: 'object',
          properties: { markdown: { type: 'string', minLength: 1 } },
          required: ['markdown'],
        },
      },
      async run(caller, args, signal) {
        const markdown = text(args, 'markdown');
        const problem = recordProblem('plan', markdown);
        if (problem !== undefined) {
          throw invalid(problem);
        }
        const approval = (await plansNeedApproval(caller))
          ? 'required'
          : 'none';
        const { id, recordId } = await recordHeld(caller, {
          approval,
          kind: 'plan',
          markdown,
        });
        if (approval === 'none' || plans === undefined) {
          return { id, recorded: 'plan' };
        }
        const answer = await plans.await(
          caller.runId,
          { id: recordId, markdown },
          signal,
        );
        return answer.verdict === 'approved'
          ? {
              approved: true,
              id,
              message: 'The navigator approved the plan. Build it.',
              recorded: 'plan',
            }
          : {
              approved: false,
              changes: answer.text,
              id,
              message: `The navigator asked for changes to the plan: ${answer.text} Revise the plan and submit it again with submit_plan before writing code.`,
              recorded: 'plan',
            };
      },
    },
    show_mockups: {
      descriptor: {
        name: 'show_mockups',
        description:
          'Show the navigator a set of drawings from your checkout to choose between, and wait for their answer: the label they chose, or the change they wrote. Each drawing is a self-contained HTML page or a PNG, JPEG, GIF, WebP or SVG image, named by its path relative to the checkout; start each label with its letter ("A · Button in the toolbar") and say in `cost` what choosing it costs, in a line. The set is all or nothing: if any drawing is refused, none is shown and the navigator sees nothing; fix what the refusal names and send the whole set again.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', minLength: 1 },
            drawings: {
              type: 'array',
              minItems: 1,
              maxItems: maxFetchPaths,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', minLength: 1 },
                  label: { type: 'string', minLength: 1 },
                  cost: { type: 'string' },
                  recommended: { type: 'boolean' },
                },
                required: ['path', 'label', 'cost'],
              },
            },
          },
          required: ['question', 'drawings'],
        },
      },
      async run(caller, args, signal) {
        const set = drawingSetOf(args);
        const itemId = await requireHeld(caller);
        if (
          drawings === undefined ||
          mockups === undefined ||
          fetchFiles === undefined
        ) {
          throw new Refusal(
            'refused',
            'Drawings cannot be shown on this instance.',
          );
        }
        const preparing = await drawings.prepare(
          caller.runId,
          { count: set.drawings.length, question: set.question },
          signal,
        );
        let shown: Drawing[];
        try {
          const files = await fetchFiles(
            caller.runId,
            set.drawings.map((drawing) => drawing.path),
          );
          const content = new Map(
            files.map((file) => [
              file.path,
              Buffer.from(file.content, 'base64'),
            ]),
          );
          for (const drawing of set.drawings) {
            const problem = drawingContentProblem(
              drawing.path,
              drawing.type,
              content.get(drawing.path) ?? Buffer.alloc(0),
            );
            if (problem !== null) throw setRefused(problem);
          }
          shown = [];
          for (const drawing of set.drawings) {
            const mockupId = await mockups.save({
              content: content.get(drawing.path)!,
              contentType: drawing.type,
              path: drawing.path,
              runId: caller.runId,
              workItemId: itemId,
            });
            shown.push({
              cost: drawing.cost,
              label: drawing.label,
              mockupId,
              recommended: drawing.recommended,
            });
          }
        } catch (error) {
          await preparing.withdraw();
          if (error instanceof FileRequestError) {
            throw setRefused(error.message);
          }
          throw error;
        }
        const answer = await preparing.show(shown);
        return {
          choice: answer.choice,
          message:
            answer.choice === null
              ? `The navigator asked for a change: ${answer.text} Revise the drawings and show them again with show_mockups.`
              : `The navigator chose ${answer.choice}.`,
          text: answer.text,
        };
      },
    },
    report_checks: {
      descriptor: {
        name: 'report_checks',
        description:
          'Report the result of running the project’s checks on the item this run is building. The newest report must have passed before the item can move to review_ready.',
        inputSchema: {
          type: 'object',
          properties: {
            passed: { type: 'boolean' },
            summary: { type: 'string' },
          },
          required: ['passed'],
        },
      },
      async run(caller, args) {
        if (typeof args.passed !== 'boolean') {
          throw invalid('passed must be a boolean.');
        }
        const summary = optionalText(args, 'summary')?.trim() ?? '';
        const { id, recorded } = await recordHeld(caller, {
          kind: 'checks',
          passed: args.passed,
          summary,
        });
        return { id, recorded };
      },
    },
    wait_for_navigator: {
      descriptor: {
        name: 'wait_for_navigator',
        description:
          'Put the held work item in front of the navigator with a question. This gives up the hold: the item returns to its queue once answered, and this run holds nothing after.',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string', minLength: 1 } },
          required: ['question'],
        },
      },
      async run(caller, args) {
        const question = text(args, 'question').trim();
        if (question === '') {
          throw invalid('question must not be empty.');
        }
        return moveHeld(caller, (state) => ({
          actor: { role: caller.role, runId: caller.runId },
          to: 'waiting',
          waiting: {
            kind: 'question',
            reason: question,
            returnState: queueFor(state) ?? state,
          },
        }));
      },
    },
  };

  return {
    list(caller) {
      return caller.tools
        .filter((name) => Object.hasOwn(tools, name))
        .map((name) => (tools[name] as Tool).descriptor);
    },

    async call(caller, name, args, signal) {
      const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
      if (tool === undefined) {
        return refusal('unknown_tool', `There is no tool named ${name}.`);
      }
      if (!caller.tools.includes(name)) {
        return refusal(
          'tool_not_allowed',
          `A ${caller.role} run may not call ${name}.`,
        );
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return refusal('invalid_arguments', 'Arguments must be an object.');
      }
      try {
        return {
          ok: true,
          value: await tool.run(caller, args as Arguments, signal),
        };
      } catch (error) {
        if (error instanceof Refusal) {
          return refusal(error.code, error.message);
        }
        if (error instanceof WorkItemNotFoundError) {
          return refusal('not_found', error.message);
        }
        throw error;
      }
    },
  };
}

const nothingShown =
  'Nothing was shown to the navigator; fix it and send the whole set again.';

/** A refusal of a whole set of drawings: the navigator sees none of it (spec §6.4). */
function setRefused(reason: string): Refusal {
  return new Refusal('refused', `${reason} ${nothingShown}`);
}

interface DrawingToShow {
  readonly path: string;
  readonly type: MockupContentType;
  readonly label: string;
  readonly cost: string;
  readonly recommended: boolean;
}

/** A designer's set of drawings, checked whole before anything of it is shown. */
function drawingSetOf(args: Arguments): {
  readonly question: string;
  readonly drawings: readonly DrawingToShow[];
} {
  const refuse = (reason: string) =>
    new Refusal('invalid_arguments', `${reason} ${nothingShown}`);
  const question =
    typeof args.question === 'string' ? args.question.trim() : '';
  if (question === '') throw refuse('question must be a non-empty string.');
  const listed = args.drawings;
  if (
    !Array.isArray(listed) ||
    listed.length < 1 ||
    listed.length > maxFetchPaths
  ) {
    throw refuse(`drawings must list between 1 and ${maxFetchPaths} drawings.`);
  }
  const labels = new Set<string>();
  const drawings = listed.map((entry: unknown): DrawingToShow => {
    const fields =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    const { cost, label, path, recommended } = fields;
    if (typeof label !== 'string' || label.trim() === '') {
      throw refuse('Each drawing needs a label.');
    }
    if (labels.has(label.trim())) {
      throw refuse(`Two drawings share the label ${label.trim()}.`);
    }
    labels.add(label.trim());
    if (typeof cost !== 'string') {
      throw refuse(`The cost of ${label.trim()} must be a string.`);
    }
    if (recommended !== undefined && typeof recommended !== 'boolean') {
      throw refuse(`recommended of ${label.trim()} must be a boolean.`);
    }
    if (typeof path !== 'string' || path === '') {
      throw refuse(`${label.trim()} needs the path of its file.`);
    }
    if (path.startsWith('/') || path.split(/[\\/]/).includes('..')) {
      throw refuse(`${path} is outside your checkout.`);
    }
    const type = drawingTypeOf(path);
    if (type === null) {
      throw refuse(
        `${path} is not a web page or an image: a drawing is an HTML page or a PNG, JPEG, GIF, WebP or SVG image.`,
      );
    }
    return {
      cost: cost.trim(),
      label: label.trim(),
      path,
      recommended: recommended === true,
      type,
    };
  });
  return { drawings, question };
}

/** `owner/name` of a GitHub remote, https or ssh, or null for anything else. */
function repositoryOf(remote: string): string | null {
  return (
    /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote)?.[1] ?? null
  );
}

function refusal(code: ToolRefusalCode, message: string): ToolOutcome {
  return { code, message, ok: false };
}

function invalid(message: string): Refusal {
  return new Refusal('invalid_arguments', message);
}

function text(args: Arguments, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw invalid(`${key} must be a string.`);
  }
  return value;
}

function optionalText(args: Arguments, key: string): string | undefined {
  return args[key] === undefined ? undefined : text(args, key);
}

function oneOf<T extends string>(
  args: Arguments,
  key: string,
  values: readonly T[],
): T {
  const value = args[key];
  if (
    typeof value !== 'string' ||
    !(values as readonly string[]).includes(value)
  ) {
    throw invalid(`${key} must be one of ${values.join(', ')}.`);
  }
  return value as T;
}

function optionalOneOf<T extends string>(
  args: Arguments,
  key: string,
  values: readonly T[],
): T | undefined {
  return args[key] === undefined ? undefined : oneOf(args, key, values);
}

function optionalLimit(args: Arguments): number | undefined {
  const value = args.limit;
  if (value === undefined) {
    return undefined;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 100
  ) {
    throw invalid('limit must be an integer from 1 to 100.');
  }
  return value as number;
}
