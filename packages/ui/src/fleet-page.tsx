import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  browserFleetClient,
  modelOptions,
  type AgentModel,
  type AgentRole,
  type FleetClient,
  type FleetPerson,
  type FleetRole,
  type FleetView,
  type StartMode,
} from './fleet';

type FleetStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StatusFilter = '' | 'waiting' | 'working' | 'available' | 'disabled';

interface Filters {
  readonly role: '' | AgentRole;
  readonly status: StatusFilter;
}

const filtersKey = 'cerebra.fleet.filters';
const noFilters: Filters = { role: '', status: '' };

const roleNames: Record<AgentRole, string> = {
  assistant: 'Assistant',
  bugfixer: 'Bug fixer',
  designer: 'Designer',
  groomer: 'Groomer',
  producer: 'Producer',
  reviewer: 'Reviewer',
};

const statusOptions: readonly { value: StatusFilter; label: string }[] = [
  { label: 'All statuses', value: '' },
  { label: 'Waiting for your answer', value: 'waiting' },
  { label: 'Working now', value: 'working' },
  { label: 'Available', value: 'available' },
  { label: 'Disabled', value: 'disabled' },
];

function roleWord(role: AgentRole): string {
  return roleNames[role].toLowerCase();
}

function modelLabel(model: AgentModel): string {
  return modelOptions.find((option) => option.id === model)?.label ?? model;
}

function statusOf(person: FleetPerson): Exclude<StatusFilter, ''> {
  if (person.activity.kind !== 'available') return person.activity.kind;
  return person.enabled ? 'available' : 'disabled';
}

function browserStorage(): FleetStorage {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

function readFilters(storage: FleetStorage): Filters {
  try {
    const stored = JSON.parse(storage.getItem(filtersKey) ?? 'null') as {
      role?: unknown;
      status?: unknown;
    } | null;
    if (stored === null || typeof stored !== 'object') return noFilters;
    return {
      role:
        typeof stored.role === 'string' && stored.role in roleNames
          ? (stored.role as AgentRole)
          : '',
      status: statusOptions.some((option) => option.value === stored.status)
        ? (stored.status as StatusFilter)
        : '',
    };
  } catch {
    return noFilters;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Keeps Tab inside a modal and closes it on Escape. */
function Modal({
  children,
  labelledBy,
  onClose,
}: {
  readonly children: ReactNode;
  readonly labelledBy: string;
  readonly onClose: () => void;
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          'button, input, select',
        ),
      ).filter((element) => !element.hasAttribute('disabled'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  return (
    <div
      aria-labelledby={labelledBy}
      aria-modal="true"
      className="fixed inset-0 z-20 grid place-items-center bg-black/40 p-5"
      onKeyDown={onKeyDown}
      role="dialog"
    >
      <section className="card w-full max-w-md">{children}</section>
    </div>
  );
}

function NameDialog({
  initialName,
  onCancel,
  onSubmit,
  roles,
  submitLabel,
  title,
}: {
  readonly initialName: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    name: string;
    typeId: string;
  }) => Promise<string | null>;
  readonly roles?: readonly FleetRole[];
  readonly submitLabel: string;
  readonly title: string;
}): ReactNode {
  const id = useId();
  const [name, setName] = useState(initialName);
  const [typeId, setTypeId] = useState(
    () =>
      roles?.find((role) => role.role === 'producer')?.typeId ??
      roles?.[0]?.typeId ??
      '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Enter a name.');
      return;
    }
    setBusy(true);
    setError(await onSubmit({ name: name.trim(), typeId }));
    setBusy(false);
  };

  return (
    <Modal labelledBy={`${id}-title`} onClose={onCancel}>
      <form noValidate onSubmit={(event) => void submit(event)}>
        <h2 className="text-xl font-bold" id={`${id}-title`}>
          {title}
        </h2>
        <label className="auth-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          aria-describedby={error ? `${id}-error` : undefined}
          aria-invalid={error ? true : undefined}
          autoFocus
          className="auth-input"
          id={`${id}-name`}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
        {roles ? (
          <>
            <label className="auth-label" htmlFor={`${id}-role`}>
              Role
            </label>
            <select
              className="auth-input"
              id={`${id}-role`}
              onChange={(event) => setTypeId(event.target.value)}
              value={typeId}
            >
              {roles.map((role) => (
                <option key={role.typeId} value={role.typeId}>
                  {roleNames[role.role]}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {error ? (
          <p className="auth-error" id={`${id}-error`}>
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={busy} type="submit">
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RoleSettingsPage({
  onCancel,
  onSave,
  projectName,
  role,
}: {
  readonly onCancel: () => void;
  readonly onSave: (settings: {
    model: AgentModel;
    startMode: StartMode | null;
  }) => Promise<boolean>;
  readonly projectName: string;
  readonly role: FleetRole;
}): ReactNode {
  const id = useId();
  const [model, setModel] = useState<AgentModel>(role.model);
  const [startMode, setStartMode] = useState<StartMode | null>(role.startMode);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const word = roleWord(role.role);

  const save = async () => {
    setSaving(true);
    setFailed(false);
    const saved = await onSave({ model, startMode });
    if (!saved) {
      setSaving(false);
      setFailed(true);
    }
  };

  return (
    <section className="mx-auto max-w-3xl">
      <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
        Role settings
      </h2>
      <h3 className="mt-6 text-xl font-bold">{roleNames[role.role]}</h3>
      <p className="mt-2 text-[var(--muted)]">
        These choices apply to every {word} in {projectName}. They do not
        interrupt work already under way.
      </p>
      {failed ? (
        <div className="auth-error" role="alert">
          <p>Cerebra couldn’t save the {word} settings.</p>
          <button
            className="secondary-button mt-3"
            onClick={() => void save()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      <form
        className="card mt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="block text-sm font-bold" htmlFor={`${id}-model`}>
          Conversation model
        </label>
        <select
          className="auth-input"
          id={`${id}-model`}
          onChange={(event) => setModel(event.target.value as AgentModel)}
          value={model}
        >
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {role.startMode !== null ? (
          <div
            aria-labelledby={`${id}-start`}
            className="mt-6"
            role="radiogroup"
          >
            <p className="text-sm font-bold" id={`${id}-start`}>
              When {word}s start
            </p>
            {(
              [
                [
                  'ready',
                  'Start when work is ready',
                  `Cerebra assigns the next ready change to an available ${word}.`,
                ],
                [
                  'manual',
                  'Start only when I choose',
                  `A ${word} stays available until you start it from the fleet.`,
                ],
              ] as const
            ).map(([value, label, help]) => (
              <label
                className="mt-3 flex gap-3 rounded-lg border border-[var(--border)] p-3"
                key={value}
              >
                <input
                  checked={startMode === value}
                  className="accent-[var(--accent)]"
                  name={`${id}-start`}
                  onChange={() => setStartMode(value)}
                  type="radio"
                  value={value}
                />
                <span>
                  <strong className="block">{label}</strong>
                  <small className="mt-1 block text-[var(--muted)]">
                    {help}
                  </small>
                </span>
              </label>
            ))}
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={saving} type="submit">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </section>
  );
}

function PersonCard({
  onMenu,
  onOpenChat,
  onStart,
  onStop,
  onViewWork,
  person,
  startMode,
}: {
  readonly onMenu: (
    action: 'rename' | 'toggle' | 'remove',
    trigger: HTMLElement,
  ) => void;
  readonly onOpenChat: () => void;
  readonly onStart: () => void;
  readonly onStop: (trigger: HTMLElement) => void;
  readonly onViewWork: (itemId: string) => void;
  readonly person: FleetPerson;
  readonly startMode: StartMode | null;
}): ReactNode {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const keepMenuFocus = useRef(false);
  const { activity } = person;
  const interactive = startMode === null;
  const status = statusOf(person);

  let statusText: string;
  let heading: string;
  let detail: string | null;
  let actions: ReactNode;
  const link =
    'font-bold text-[var(--accent)] underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-[var(--focus)] rounded';

  if (activity.kind === 'waiting') {
    statusText = 'Waiting for your answer';
    heading = activity.item.title;
    detail = activity.question;
    actions = (
      <>
        <button className={link} onClick={onOpenChat} type="button">
          Open chat
        </button>
        <button
          className={link}
          onClick={(event) => onStop(event.currentTarget)}
          type="button"
        >
          Stop
        </button>
      </>
    );
  } else if (activity.kind === 'working') {
    statusText = 'Working now';
    heading = activity.item.title;
    detail = null;
    actions = (
      <>
        <button
          className={link}
          onClick={() => onViewWork(activity.item.id)}
          type="button"
        >
          View work
        </button>
        <button
          className={link}
          onClick={(event) => onStop(event.currentTarget)}
          type="button"
        >
          Stop
        </button>
      </>
    );
  } else if (!person.enabled) {
    statusText = 'Disabled';
    heading = 'No work in hand';
    detail = `Won’t start until you enable ${person.name}.`;
    actions = null;
  } else if (interactive) {
    statusText = 'Ready to talk';
    heading = 'Start a conversation';
    detail = 'Ask about this project, file work, or request a release.';
    actions = (
      <button className={link} onClick={onOpenChat} type="button">
        Open chat
      </button>
    );
  } else {
    statusText = 'Available';
    heading = 'No work in hand';
    detail =
      startMode === 'manual'
        ? 'Available when needed'
        : `Starts when work is ready for a ${roleWord(person.role)}.`;
    actions = (
      <button className={link} onClick={onStart} type="button">
        Start
      </button>
    );
  }

  const dot = {
    available: 'bg-emerald-500',
    disabled: 'bg-slate-400',
    waiting: 'bg-fuchsia-500',
    working: 'bg-amber-500',
  }[status];

  const item =
    'flex cursor-default select-none rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-[var(--accent-muted)]';

  return (
    <article
      aria-label={person.name}
      className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--accent-muted)] font-extrabold text-[var(--accent)]"
        >
          {person.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-extrabold">{person.name}</h3>
          <p className="text-sm text-[var(--muted)]">
            {roleNames[person.role]}
          </p>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              aria-label={`More actions for ${person.name}`}
              className="rounded-lg px-2 text-lg leading-none text-[var(--muted)] outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
              ref={menuTrigger}
              type="button"
            >
              •••
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-10 w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl outline-none"
              onCloseAutoFocus={(event) => {
                if (keepMenuFocus.current) {
                  keepMenuFocus.current = false;
                  event.preventDefault();
                }
              }}
              sideOffset={6}
            >
              {(
                [
                  ['rename', 'Rename'],
                  ['toggle', person.enabled ? 'Disable' : 'Enable'],
                  ['remove', 'Remove'],
                ] as const
              ).map(([action, label]) => (
                <DropdownMenu.Item
                  className={item}
                  key={action}
                  onSelect={() => {
                    keepMenuFocus.current = action === 'rename';
                    if (menuTrigger.current) {
                      onMenu(action, menuTrigger.current);
                    }
                  }}
                >
                  {label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <p className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-[var(--page)] p-2.5 text-sm text-[var(--muted)]">
        <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
        {statusText}
      </p>
      <div className="border-t border-[var(--border)] px-4 pb-4 pt-3 text-sm text-[var(--muted)]">
        <p className="break-words font-bold text-[var(--foreground)]">
          {heading}
        </p>
        {detail ? <p className="mt-1 break-words">{detail}</p> : null}
        {actions ? (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">{actions}</div>
        ) : null}
      </div>
    </article>
  );
}

type Confirmation =
  | { kind: 'stop'; person: FleetPerson; trigger: HTMLElement }
  | { kind: 'remove'; person: FleetPerson; trigger: HTMLElement };

type Editing =
  | { kind: 'add'; trigger: HTMLElement }
  | { kind: 'rename'; person: FleetPerson; trigger: HTMLElement };

export function FleetPage({
  client = browserFleetClient,
  onOpenChat,
  onViewWork,
  projectId,
  refreshIntervalMs = 15_000,
  storage: storageOverride,
}: {
  readonly client?: FleetClient;
  /** Called once a person's conversation has been started. */
  readonly onOpenChat?: (person: FleetPerson) => void;
  readonly onViewWork?: (itemId: string) => void;
  readonly projectId: string;
  readonly refreshIntervalMs?: number;
  readonly storage?: FleetStorage;
}): ReactNode {
  const [storage] = useState<FleetStorage>(
    () => storageOverride ?? browserStorage(),
  );
  const [view, setView] = useState<FleetView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<'people' | 'roles'>('people');
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(() => readFilters(storage));
  const [problem, setProblem] = useState<{
    reason?: string;
    title: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useRef(projectId);
  const id = useId();

  const load = useCallback(async () => {
    const requested = projectId;
    try {
      const fleet = await client.read(requested);
      if (current.current !== requested) return;
      setView(fleet);
      setLoadFailed(false);
    } catch {
      if (current.current !== requested) return;
      setLoadFailed(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    current.current = projectId;
    setView(null);
    setLoadFailed(false);
    setTab('people');
    setSettingsFor(null);
    setProblem(null);
    void load();
    const timer = window.setInterval(() => void load(), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [load, projectId, refreshIntervalMs]);

  const chooseFilters = (next: Filters) => {
    setFilters(next);
    try {
      storage.setItem(filtersKey, JSON.stringify(next));
    } catch {
      // The choice still applies for this visit.
    }
  };

  const replacePerson = (person: FleetPerson) =>
    setView((previous) =>
      previous
        ? {
            ...previous,
            people: previous.people.map((entry) =>
              entry.id === person.id ? person : entry,
            ),
          }
        : previous,
    );

  const startPerson = async (person: FleetPerson, chat: boolean) => {
    setProblem(null);
    try {
      await client.start(person.id);
      if (chat) onOpenChat?.(person);
      void load();
    } catch (error) {
      setProblem({
        reason: errorMessage(error),
        title: `Cerebra couldn’t start ${person.name}.`,
      });
    }
  };

  const closeConfirmation = () => {
    const trigger = confirmation?.trigger;
    setConfirmation(null);
    trigger?.focus();
  };

  const confirm = async () => {
    if (!confirmation) return;
    const { person, trigger } = confirmation;
    setConfirmation(null);
    setProblem(null);
    if (confirmation.kind === 'stop') {
      trigger.focus();
      try {
        await client.stop(person.id);
        void load();
      } catch (error) {
        setProblem({
          reason: errorMessage(error),
          title: `Cerebra couldn’t stop ${person.name}.`,
        });
      }
      return;
    }
    try {
      await client.removePerson(person.id);
      setView((previous) =>
        previous
          ? {
              ...previous,
              people: previous.people.filter((entry) => entry.id !== person.id),
              roles: previous.roles.map((role) => ({
                ...role,
                people: role.people.filter((name) => name !== person.name),
              })),
            }
          : previous,
      );
      heading.current?.focus();
    } catch (error) {
      trigger.focus();
      setProblem({
        reason: errorMessage(error),
        title: `Cerebra couldn’t remove ${person.name}.`,
      });
    }
  };

  const onMenu = async (
    person: FleetPerson,
    action: 'rename' | 'toggle' | 'remove',
    trigger: HTMLElement,
  ) => {
    setProblem(null);
    if (action === 'rename') {
      setEditing({ kind: 'rename', person, trigger });
      return;
    }
    if (action === 'remove') {
      if (person.activity.kind !== 'available') {
        setProblem({ title: `Stop this work before removing ${person.name}.` });
        return;
      }
      setConfirmation({ kind: 'remove', person, trigger });
      return;
    }
    try {
      replacePerson(
        await client.updatePerson(person.id, { enabled: !person.enabled }),
      );
    } catch (error) {
      setProblem({
        reason: errorMessage(error),
        title: `Cerebra couldn’t ${person.enabled ? 'disable' : 'enable'} ${person.name}.`,
      });
    }
  };

  const submitEditing = async (input: {
    name: string;
    typeId: string;
  }): Promise<string | null> => {
    if (!editing || !view) return null;
    try {
      if (editing.kind === 'add') {
        const added = await client.addPerson(projectId, input);
        setView((previous) => {
          if (!previous) return previous;
          const order = previous.roles.map((role) => role.role);
          const position = previous.people.findIndex(
            (entry) => order.indexOf(entry.role) > order.indexOf(added.role),
          );
          const people = [...previous.people];
          people.splice(position === -1 ? people.length : position, 0, added);
          return {
            ...previous,
            people,
            roles: previous.roles.map((role) =>
              role.typeId === added.typeId
                ? { ...role, people: [...role.people, added.name] }
                : role,
            ),
          };
        });
      } else {
        const previousName = editing.person.name;
        const renamed = await client.updatePerson(editing.person.id, {
          name: input.name,
        });
        replacePerson(renamed);
        setView((previous) =>
          previous
            ? {
                ...previous,
                roles: previous.roles.map((role) => ({
                  ...role,
                  people: role.people.map((name) =>
                    name === previousName ? renamed.name : name,
                  ),
                })),
              }
            : previous,
        );
      }
      const trigger = editing.trigger;
      setEditing(null);
      trigger.focus();
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  };

  const closeEditing = () => {
    const trigger = editing?.trigger;
    setEditing(null);
    trigger?.focus();
  };

  const projectName = view
    ? `${view.project.owner}/${view.project.name}`
    : null;
  const settingsRole = view?.roles.find((role) => role.typeId === settingsFor);

  if (view && projectName && settingsRole) {
    return (
      <RoleSettingsPage
        key={settingsRole.typeId}
        onCancel={() => setSettingsFor(null)}
        onSave={async (settings) => {
          try {
            const saved = await client.saveRoleSettings(
              projectId,
              settingsRole.typeId,
              settings,
            );
            setView((previous) =>
              previous
                ? {
                    ...previous,
                    roles: previous.roles.map((role) =>
                      role.typeId === saved.typeId ? saved : role,
                    ),
                  }
                : previous,
            );
            setSettingsFor(null);
            setTab('roles');
            return true;
          } catch {
            return false;
          }
        }}
        projectName={projectName}
        role={settingsRole}
      />
    );
  }

  const people = view?.people ?? [];
  const startModes = new Map(
    view?.roles.map((role) => [role.typeId, role.startMode]) ?? [],
  );
  const visible = people.filter(
    (person) =>
      (filters.role === '' || person.role === filters.role) &&
      (filters.status === '' || statusOf(person) === filters.status),
  );
  const waiting = people.filter((person) => person.activity.kind === 'waiting');
  const tabClass = (selected: boolean) =>
    `rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] ${
      selected
        ? 'bg-[var(--surface)] font-bold text-[var(--foreground)] shadow-sm'
        : 'text-[var(--muted)]'
    }`;

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2
        className="text-2xl font-extrabold tracking-tight outline-none sm:text-3xl"
        id={`${id}-heading`}
        ref={heading}
        tabIndex={-1}
      >
        Your fleet
      </h2>
      {projectName ? (
        <p className="mt-1.5 text-[var(--muted)]">
          The people working on {projectName}. Start a conversation or see what
          each one is doing.
        </p>
      ) : null}

      {loadFailed ? (
        <div className="auth-error" role="alert">
          <p className="font-bold">Cerebra couldn’t load this fleet.</p>
          {view ? (
            <p>Your saved view is still here, but it may be out of date.</p>
          ) : null}
          <button
            className="secondary-button mt-3"
            onClick={() => void load()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      {problem ? (
        <div className="auth-error" role="alert">
          <p className="font-bold">{problem.title}</p>
          {problem.reason ? <p>{problem.reason}</p> : null}
        </div>
      ) : null}
      {waiting.length > 0 ? (
        <div
          className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          role="status"
        >
          <strong>
            {waiting.length === 1
              ? '1 agent needs you.'
              : `${waiting.length} agents need you.`}
          </strong>
          {waiting.length === 1 ? (
            <span>{waiting[0].name} is waiting for an answer.</span>
          ) : null}
          <button
            className="font-bold text-[var(--accent)] underline underline-offset-4"
            onClick={() => void startPerson(waiting[0], true)}
            type="button"
          >
            Open chat
          </button>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div
          aria-label="Fleet views"
          className="flex gap-1 rounded-lg bg-[var(--border)] p-1"
          role="tablist"
        >
          <button
            aria-controls={`${id}-panel`}
            aria-selected={tab === 'people'}
            className={tabClass(tab === 'people')}
            onClick={() => setTab('people')}
            role="tab"
            type="button"
          >
            People {view ? <span>{people.length}</span> : null}
          </button>
          <button
            aria-controls={`${id}-panel`}
            aria-selected={tab === 'roles'}
            className={tabClass(tab === 'roles')}
            onClick={() => setTab('roles')}
            role="tab"
            type="button"
          >
            Roles
          </button>
        </div>
        {view && people.length > 0 ? (
          <button
            className="primary-button"
            onClick={(event) =>
              setEditing({ kind: 'add', trigger: event.currentTarget })
            }
            type="button"
          >
            Add person
          </button>
        ) : null}
      </div>

      <div className="mt-5" id={`${id}-panel`} role="tabpanel">
        {view === null ? (
          loadFailed ? null : (
            <div
              aria-label="Loading the fleet"
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  aria-hidden="true"
                  className="h-44 animate-pulse rounded-2xl border border-[var(--border)] bg-[var(--surface)] motion-reduce:animate-none"
                  data-testid="person-placeholder"
                  key={index}
                />
              ))}
            </div>
          )
        ) : tab === 'roles' ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {view.roles.map((role) => (
              <article
                aria-label={roleNames[role.role]}
                className="card min-w-0"
                key={role.typeId}
              >
                <h3 className="font-extrabold">{roleNames[role.role]}</h3>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Conversation model: {modelLabel(role.model)}
                </p>
                {role.startMode ? (
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {role.startMode === 'ready'
                      ? 'Start when work is ready'
                      : 'Start only when I choose'}
                  </p>
                ) : null}
                <p className="mt-3 break-words text-sm">
                  {role.people.length > 0
                    ? role.people.join(', ')
                    : 'No one in this role yet'}
                </p>
                <button
                  aria-label={`Change ${roleWord(role.role)} settings`}
                  className="secondary-button mt-4"
                  onClick={() => setSettingsFor(role.typeId)}
                  type="button"
                >
                  Change settings
                </button>
              </article>
            ))}
          </div>
        ) : people.length === 0 ? (
          <div className="card text-center">
            <p className="text-xl font-bold">No people in this fleet yet</p>
            <p className="mb-4 mt-1.5 text-[var(--muted)]">
              Add someone to begin working with this project.
            </p>
            <button
              className="primary-button"
              onClick={(event) =>
                setEditing({ kind: 'add', trigger: event.currentTarget })
              }
              type="button"
            >
              Add person
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-3">
              <label className="text-sm font-bold">
                Role
                <select
                  className="auth-input mt-1 w-auto"
                  onChange={(event) =>
                    chooseFilters({
                      ...filters,
                      role: event.target.value as Filters['role'],
                    })
                  }
                  value={filters.role}
                >
                  <option value="">All roles</option>
                  {view.roles.map((role) => (
                    <option key={role.typeId} value={role.role}>
                      {roleNames[role.role]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-bold">
                Status
                <select
                  className="auth-input mt-1 w-auto"
                  onChange={(event) =>
                    chooseFilters({
                      ...filters,
                      status: event.target.value as StatusFilter,
                    })
                  }
                  value={filters.status}
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {visible.length === 0 ? (
              <div className="card text-center">
                <p className="font-bold">No one matches these filters.</p>
                <button
                  className="secondary-button mt-4"
                  onClick={() => chooseFilters(noFilters)}
                  type="button"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <section
                aria-label="People in this fleet"
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {visible.map((person) => (
                  <PersonCard
                    key={person.id}
                    onMenu={(action, trigger) =>
                      void onMenu(person, action, trigger)
                    }
                    onOpenChat={() => void startPerson(person, true)}
                    onStart={() => void startPerson(person, false)}
                    onStop={(trigger) =>
                      setConfirmation({ kind: 'stop', person, trigger })
                    }
                    onViewWork={(itemId) => onViewWork?.(itemId)}
                    person={person}
                    startMode={startModes.get(person.typeId) ?? null}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>

      {confirmation ? (
        <Modal labelledBy={`${id}-confirm`} onClose={closeConfirmation}>
          <h2 className="text-xl font-bold" id={`${id}-confirm`}>
            {confirmation.kind === 'stop'
              ? `Stop ${confirmation.person.name}?`
              : `Remove ${confirmation.person.name}?`}
          </h2>
          <p className="mt-3 text-[var(--muted)]">
            {confirmation.kind === 'stop'
              ? `${confirmation.person.name} will stop working on ‘${
                  confirmation.person.activity.kind === 'available'
                    ? ''
                    : confirmation.person.activity.item.title
                }.’`
              : `${confirmation.person.name} has no work in hand. This removes ${confirmation.person.name} from this project.`}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              autoFocus
              className="secondary-button"
              onClick={closeConfirmation}
              type="button"
            >
              {confirmation.kind === 'stop' ? 'Keep working' : 'Cancel'}
            </button>
            <button
              className="primary-button"
              onClick={() => void confirm()}
              type="button"
            >
              {confirmation.kind === 'stop' ? 'Stop' : 'Remove person'}
            </button>
          </div>
        </Modal>
      ) : null}

      {editing && view ? (
        <NameDialog
          initialName={editing.kind === 'rename' ? editing.person.name : ''}
          onCancel={closeEditing}
          onSubmit={submitEditing}
          roles={editing.kind === 'add' ? view.roles : undefined}
          submitLabel={editing.kind === 'add' ? 'Add person' : 'Save name'}
          title={
            editing.kind === 'add'
              ? 'Add person'
              : `Rename ${editing.person.name}`
          }
        />
      ) : null}
    </section>
  );
}
