import { sql, type Kysely } from 'kysely';

import {
  filingLockKey,
  getLockedItem,
  isRouteAvailable,
  persistTransition,
  type BoardRoute,
} from './board.js';
import { workItemTypes, type Database, type WorkItemType } from './database.js';
import {
  createWorkItem,
  transition,
  type Priority,
  type TransitionRequest,
} from './lifecycle.js';

/**
 * Carrying a repository's open work over by hand from its classic beads board (roadmap step 9).
 * The general importer is v1 (spec §13, D41); this files what a person wrote down, item by item.
 */

export type CarriedState = 'new' | BoardRoute;

interface ManifestItemBase {
  readonly description: string;
  readonly oldName: string;
  readonly priority?: Priority;
  readonly title: string;
  readonly type: WorkItemType;
}

export type CarryOverItem =
  | (ManifestItemBase & { readonly state: CarriedState })
  | (ManifestItemBase & { readonly notCarriedOver: string });

export interface CarryOverManifest {
  /** The registered project, as `owner/name`. */
  readonly project: string;
  readonly items: readonly CarryOverItem[];
}

export interface CarriedItem {
  readonly key: string;
  readonly oldName: string;
  readonly state: CarriedState | 'cancelled';
}

/** A manifest that does not say what to carry; nothing was read from the database. */
export class CarryOverManifestError extends Error {}

/** A carry-over the board refused; nothing was filed. */
export class CarryOverError extends Error {}

const carriedStates: readonly CarriedState[] = [
  'new',
  'grooming_ready',
  'design_ready',
  'build_ready',
];
const priorities: readonly Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function parseCarryOverManifest(json: unknown): CarryOverManifest {
  const refuse = (message: string): never => {
    throw new CarryOverManifestError(message);
  };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return refuse('The manifest must be a JSON object.');
  }
  const { items, project } = json as Record<string, unknown>;
  if (typeof project !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(project)) {
    return refuse('The manifest must name its project as owner/name.');
  }
  if (!Array.isArray(items)) {
    return refuse('The manifest must list its items.');
  }
  return {
    items: items.map((entry: unknown, index): CarryOverItem => {
      const item = (
        typeof entry === 'object' && entry !== null ? entry : {}
      ) as Record<string, unknown>;
      const oldName =
        typeof item.oldName === 'string' ? item.oldName.trim() : '';
      if (oldName === '') refuse(`Item ${index + 1} must give its oldName.`);
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (title === '') refuse(`${oldName} must give its title.`);
      const description =
        typeof item.description === 'string' ? item.description : '';
      const type = item.type;
      if (!workItemTypes.includes(type as WorkItemType)) {
        refuse(
          `${oldName} has type ${String(type)}; use feature, bug, task or refactoring.`,
        );
      }
      const priority = item.priority;
      if (
        priority !== undefined &&
        !priorities.includes(priority as Priority)
      ) {
        refuse(
          `${oldName} has priority ${String(priority)}; use P0, P1, P2 or P3.`,
        );
      }
      const base = {
        description,
        oldName,
        ...(priority === undefined ? {} : { priority: priority as Priority }),
        title,
        type: type as WorkItemType,
      };
      const { notCarriedOver, state } = item;
      if (state !== undefined && notCarriedOver !== undefined) {
        refuse(`${oldName} gives both a state and notCarriedOver; choose one.`);
      }
      if (notCarriedOver !== undefined) {
        if (
          typeof notCarriedOver !== 'string' ||
          notCarriedOver.trim() === ''
        ) {
          refuse(`${oldName} must give its reason for notCarriedOver.`);
        }
        if (priority !== undefined) {
          refuse(
            `${oldName} is not carried over, so it cannot keep a priority.`,
          );
        }
        return { ...base, notCarriedOver: (notCarriedOver as string).trim() };
      }
      if (state === undefined) {
        refuse(
          `${oldName} must give a state, or notCarriedOver with a reason.`,
        );
      }
      if (!carriedStates.includes(state as CarriedState)) {
        refuse(
          `${oldName} has state ${String(state)}; use new, grooming_ready, design_ready or build_ready.`,
        );
      }
      if (state === 'new' && priority !== undefined) {
        refuse(`${oldName} cannot keep a priority in new.`);
      }
      if (state !== 'new' && priority === undefined) {
        refuse(`${oldName} needs a priority to go to ${String(state)}.`);
      }
      return { ...base, state: state as CarriedState };
    }),
    project,
  };
}

/**
 * Files every item of the manifest in one transaction, so it lands whole or not at all. Each item
 * is filed in `new` naming the old item it came from; a carried item then moves, as the navigator
 * and through the lifecycle, into the state it was in, and that one history entry is its Carried
 * over entry. An item not carried over gets its Carried over entry and is cancelled with the reason.
 */
export async function carryOver(
  database: Kysely<Database>,
  manifest: CarryOverManifest,
): Promise<readonly CarriedItem[]> {
  const seen = new Set<string>();
  for (const item of manifest.items) {
    if (seen.has(item.oldName)) {
      throw new CarryOverError(
        `${item.oldName} is named more than once in the manifest.`,
      );
    }
    seen.add(item.oldName);
  }

  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(${filingLockKey})`.execute(
      transaction,
    );
    const [owner, name] = manifest.project.split('/');
    const project = await transaction
      .selectFrom('projects')
      .select('id')
      .where('owner', '=', owner ?? '')
      .where('name', '=', name ?? '')
      .executeTakeFirst();
    if (project === undefined) {
      throw new CarryOverError(`No project ${manifest.project} is registered.`);
    }

    const carried: CarriedItem[] = [];
    for (const item of manifest.items) {
      const earlier = await transaction
        .selectFrom('work_items')
        .select('key')
        .where('project_id', '=', project.id)
        .where('carried_from', '=', item.oldName)
        .executeTakeFirst();
      if (earlier !== undefined) {
        throw new CarryOverError(
          `${item.oldName} has already been carried over as ${earlier.key}.`,
        );
      }

      const filed = createWorkItem({ state: 'new' });
      const id = crypto.randomUUID();
      const { key } = await transaction
        .insertInto('work_items')
        .values({
          attempts: filed.attempts,
          carried_from: item.oldName,
          description: item.description,
          holder_run_id: null,
          id,
          priority: null,
          project_id: project.id,
          return_state: null,
          rounds: filed.rounds,
          state: 'new',
          title: item.title,
          type: item.type,
          waiting_kind: null,
          waiting_reason: null,
        })
        .returning('key')
        .executeTakeFirstOrThrow();

      const move = async (
        request: TransitionRequest,
        historyKind: 'carried_over' | 'transition',
      ) => {
        const current = await getLockedItem(transaction, id);
        if (
          request.to !== 'cancelled' &&
          !isRouteAvailable(request.to as BoardRoute, current.context.stages)
        ) {
          throw new CarryOverError(
            `${item.oldName} cannot go to ${request.to}: that stage is switched off for ${manifest.project}.`,
          );
        }
        const result = transition(current.item, request, current.context);
        if (!result.ok) {
          throw new CarryOverError(`${item.oldName}: ${result.reason}`);
        }
        await persistTransition(
          transaction,
          id,
          current.item,
          result,
          request,
          historyKind,
        );
      };
      const markCarried = (reason: string) =>
        transaction
          .insertInto('work_item_history')
          .values({
            actor_role: 'navigator',
            from_state: 'new',
            kind: 'carried_over',
            reason,
            to_state: 'new',
            work_item_id: id,
          })
          .execute();

      const whereItWas = `Moved here from the old task list, where it was ${item.oldName}.`;
      if ('notCarriedOver' in item) {
        await markCarried(whereItWas);
        await move(
          {
            actor: { role: 'navigator' },
            reason: `Not carried over: ${item.notCarriedOver.replace(/\.+$/, '')}.`,
            to: 'cancelled',
          },
          'transition',
        );
        carried.push({ key, oldName: item.oldName, state: 'cancelled' });
        continue;
      }

      const body = `${whereItWas} Its priority, scope and what it waits on came with it.`;
      if (item.state === 'new') {
        await markCarried(body);
      } else {
        await move(
          {
            actor: { role: 'navigator' },
            ...(item.priority === undefined ? {} : { priority: item.priority }),
            reason: body,
            record: { kind: 'triage' },
            to: item.state,
          },
          'carried_over',
        );
      }
      carried.push({ key, oldName: item.oldName, state: item.state });
    }
    return carried;
  });
}
