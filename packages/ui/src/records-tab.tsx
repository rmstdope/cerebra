import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ChosenDrawing } from './drawing-cards';

/** One version of an agreed record: its position among the item's records of its kind. */
export interface RecordVersion {
  readonly agentName: string | null;
  readonly at: string;
  readonly id: string;
  readonly markdown: string;
  /** The drawing a design record keeps; null for any other or older record. */
  readonly mockupId: string | null;
  readonly version: number;
}

export type StageRecordKind = 'outcome' | 'design';

export interface StageRecord {
  readonly kind: StageRecordKind;
  /** Oldest first. */
  readonly versions: readonly RecordVersion[];
}

export interface StageRecords {
  readonly records: readonly StageRecord[];
}

export interface RecordsClient {
  read(itemId: string): Promise<StageRecords>;
}

export const browserRecordsClient: RecordsClient = {
  read: async (itemId) => {
    const response = await fetch(
      `/api/work-items/${encodeURIComponent(itemId)}/records`,
    );
    if (!response.ok) {
      throw new Error(`Records read failed (${response.status})`);
    }
    return (await response.json()) as StageRecords;
  },
};

const stages: readonly {
  kind: StageRecordKind;
  title: string;
  noun: string;
}[] = [
  { kind: 'outcome', noun: 'the agreed outcome', title: 'Agreed outcome' },
  { kind: 'design', noun: 'the agreed design', title: 'Agreed design' },
];

const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "29 Sep", with the year when it is not this one. */
function dayOf(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = `${date.getDate()} ${months[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear()
    ? day
    : `${day} ${date.getFullYear()}`;
}

interface Section {
  readonly title: string | null;
  readonly body: string;
}

/** A record's `##` sections in order; text before the first heading is a section without one. */
function sectionsOf(markdown: string): readonly Section[] {
  const sections: { title: string | null; lines: string[] }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      sections.push({ lines: [], title: heading[1] ?? '' });
    } else if (sections.length === 0) {
      sections.push({ lines: [line], title: null });
    } else {
      sections.at(-1)!.lines.push(line);
    }
  }
  return sections
    .map((section) => ({
      body: section.lines.join('\n').trim(),
      title: section.title,
    }))
    .filter((section) => section.title !== null || section.body !== '');
}

function SectionView({
  children,
  section,
  title,
}: {
  readonly children?: ReactNode;
  readonly section: Section;
  readonly title: string | null;
}): ReactNode {
  const id = useId();
  const [open, setOpen] = useState(true);
  const body = (
    <>
      {section.body === '' ? null : (
        <p className="whitespace-pre-wrap break-words text-sm text-[var(--muted)]">
          {section.body}
        </p>
      )}
      {children}
    </>
  );
  if (title === null) return <div className="mt-2">{body}</div>;
  return (
    <div className="mt-3">
      <h4 className="text-sm font-bold">
        <button
          aria-controls={`${id}-body`}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
          onClick={() => setOpen((was) => !was)}
          type="button"
        >
          <span aria-hidden="true" className="text-xs text-[var(--muted)]">
            {open ? '▾' : '▸'}
          </span>
          <span>{title}</span>
        </button>
      </h4>
      <div hidden={!open} id={`${id}-body`}>
        {body}
      </div>
    </div>
  );
}

function RecordCard({
  now,
  onView,
  record,
  title,
  viewed,
}: {
  readonly now: Date;
  readonly onView: (version: number | null) => void;
  readonly record: StageRecord;
  readonly title: string;
  /** The version being read; null reads the newest. */
  readonly viewed: number | null;
}): ReactNode {
  const id = useId();
  const newest = record.versions.at(-1)!;
  const shown =
    record.versions.find((version) => version.version === viewed) ?? newest;
  const earlier = shown.version !== newest.version;
  const sections = sectionsOf(shown.markdown);
  const design = record.kind === 'design';

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-4 rounded-xl border border-[var(--border)] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold" id={`${id}-title`}>
          {title}
        </h3>
        <span className="flex-1" />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="secondary-button text-sm" type="button">
              {`Version ${shown.version} `}
              <span aria-hidden="true">▾</span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-10 min-w-60 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl outline-none"
              sideOffset={6}
            >
              <DropdownMenu.RadioGroup
                onValueChange={(value) => {
                  const version = Number(value);
                  onView(version === newest.version ? null : version);
                }}
                value={String(shown.version)}
              >
                {[...record.versions].reverse().map((version) => (
                  <DropdownMenu.RadioItem
                    className="relative flex w-full cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none data-[highlighted]:bg-[var(--accent-muted)] data-[state=checked]:font-bold"
                    key={version.id}
                    value={String(version.version)}
                  >
                    <span aria-hidden="true" className="w-3">
                      <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                    </span>
                    {`Version ${version.version} · ${dayOf(version.at, now)}${
                      version.version === newest.version ? ' · current' : ''
                    }`}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {earlier ? (
        <p className="mt-2 rounded-lg bg-[var(--accent-muted)] px-2.5 py-1.5 text-sm">
          <span>You are looking at an earlier version.</span>{' '}
          <button
            className="font-bold underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
            onClick={() => onView(null)}
            type="button"
          >
            Show current
          </button>
        </p>
      ) : null}
      {sections.map((section, index) => {
        const drawing = design && section.title === 'The mockup';
        return (
          <SectionView
            key={`${shown.id}-${index}`}
            section={section}
            title={drawing ? 'The drawing' : section.title}
          >
            {drawing && shown.mockupId !== null ? (
              <ChosenDrawing
                drawing={{
                  cost: '',
                  label: section.body.split('\n')[0] ?? '',
                  mockupId: shown.mockupId,
                  recommended: false,
                }}
                failure="Cerebra couldn’t load the chosen drawing. Try again."
              />
            ) : null}
          </SectionView>
        );
      })}
    </section>
  );
}

function FailedCard({
  noun,
  onRetry,
  title,
}: {
  readonly noun: string;
  readonly onRetry: () => void;
  readonly title: string;
}): ReactNode {
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-4 rounded-xl border border-[var(--danger)] p-4"
    >
      <h3 className="font-bold" id={`${id}-title`}>
        {title}
      </h3>
      <p className="mt-1 text-sm text-[var(--danger)]" role="alert">
        {`Cerebra couldn’t load ${noun}. Try again.`}
      </p>
      <button
        className="secondary-button mt-2 text-sm"
        onClick={onRetry}
        type="button"
      >
        Try again
      </button>
    </section>
  );
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'shown'; readonly records: readonly StageRecord[] };

/**
 * The agreed records on a work item (spec §4.11): a card per stage that wrote one, in lifecycle
 * order, each with every version. Refreshed quietly while open; a version confirmed meanwhile
 * becomes current without changing what is being read.
 */
export function RecordsTab({
  client = browserRecordsClient,
  intervalMs = 10_000,
  itemId,
}: {
  readonly client?: RecordsClient;
  readonly intervalMs?: number;
  readonly itemId: string;
}): ReactNode {
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [reading, setReading] = useState(false);
  const [viewed, setViewed] = useState<
    Readonly<Partial<Record<StageRecordKind, number | null>>>
  >({});
  const shownRef = useRef<readonly StageRecord[] | null>(null);
  const now = new Date();

  const load = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setRead({ kind: 'loading' });
      setReading(true);
      try {
        const { records } = await client.read(itemId);
        const before = shownRef.current;
        if (before !== null) {
          // Whoever was reading the newest version keeps reading it once a newer one arrives.
          setViewed((was) => {
            const next = { ...was };
            for (const record of records) {
              const previous = before
                .find((old) => old.kind === record.kind)
                ?.versions.at(-1)?.version;
              if (
                previous !== undefined &&
                (was[record.kind] ?? null) === null &&
                previous !== record.versions.at(-1)?.version
              ) {
                next[record.kind] = previous;
              }
            }
            return next;
          });
        }
        shownRef.current = records;
        setRead({ kind: 'shown', records });
      } catch {
        // Records only ever grow, so what is shown stays true; only a read with nothing shown fails.
        setRead((was) => (was.kind === 'shown' ? was : { kind: 'failed' }));
      } finally {
        setReading(false);
      }
    },
    [client, itemId],
  );

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, load]);

  if (read.kind === 'loading') {
    return (
      <div
        aria-busy="true"
        className="mt-4 h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
      >
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (read.kind === 'failed') {
    return (
      <div>
        {stages.map((stage) => (
          <FailedCard
            key={stage.kind}
            noun={stage.noun}
            onRetry={() => void load(false)}
            title={stage.title}
          />
        ))}
      </div>
    );
  }

  const cards = stages.flatMap((stage) => {
    const record = read.records.find((found) => found.kind === stage.kind);
    return record === undefined || record.versions.length === 0
      ? []
      : [{ record, stage }];
  });

  return (
    <div>
      {reading ? (
        <p className="mt-3 text-sm text-[var(--muted)]">Loading…</p>
      ) : null}
      {cards.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          No records yet. Each step writes one here as it finishes.
        </p>
      ) : (
        cards.map(({ record, stage }) => (
          <RecordCard
            key={stage.kind}
            now={now}
            onView={(version) =>
              setViewed((was) => ({ ...was, [stage.kind]: version }))
            }
            record={record}
            title={stage.title}
            viewed={viewed[stage.kind] ?? null}
          />
        ))
      )}
    </div>
  );
}
