import type { Attention, AttentionEntry } from './attention.js';
import type { NotificationSettings } from './notification-settings.js';

export const pushWindowMs = 30_000;

export interface PushMessage {
  readonly entries: readonly AttentionEntry[];
  readonly type: 'push';
}

export interface PushBatcher {
  push(entries: readonly AttentionEntry[]): void;
  stop(): void;
}

/** The first push opens a window; everything pushed inside it is sent as one batch when it closes. */
export function createPushBatcher({
  send,
  windowMs = pushWindowMs,
}: {
  readonly send: (entries: readonly AttentionEntry[]) => void;
  readonly windowMs?: number;
}): PushBatcher {
  const pending = new Map<string, AttentionEntry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(entries) {
      for (const entry of entries) pending.set(entry.id, entry);
      if (timer !== undefined || pending.size === 0) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = [...pending.values()];
        pending.clear();
        send(batch);
      }, windowMs);
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

export interface NotificationTab {
  /** The run whose conversation the tab is showing while focused; null when none. */
  focus(runId: string | null): void;
  close(): void;
}

/**
 * Finds what newly needs the navigator by comparing each poll with the last, and pushes it to every
 * open tab. The first poll only learns what is already there, so a restart pushes nothing old.
 */
export interface Notifier {
  connect(send: (message: PushMessage) => void): NotificationTab;
  poll(): Promise<void>;
  stop(): void;
}

export function createNotifier({
  attention,
  settings,
  windowMs,
}: {
  readonly attention: Pick<Attention, 'list'>;
  readonly settings: Pick<NotificationSettings, 'mutedProjects'>;
  readonly windowMs?: number;
}): Notifier {
  const tabs = new Map<
    object,
    { focus: string | null; send: (message: PushMessage) => void }
  >();
  let seen: ReadonlySet<string> | null = null;
  let inFlight: Promise<void> | null = null;
  const batcher = createPushBatcher({
    send: (entries) => {
      for (const tab of tabs.values()) tab.send({ entries, type: 'push' });
    },
    windowMs,
  });

  return {
    connect(send) {
      const key = {};
      tabs.set(key, { focus: null, send });
      return {
        close: () => {
          tabs.delete(key);
        },
        focus: (runId) => {
          const tab = tabs.get(key);
          if (tab !== undefined) tab.focus = runId;
        },
      };
    },

    poll() {
      // One poll at a time: a slow read is not overtaken by the next tick.
      inFlight ??= check().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    stop() {
      batcher.stop();
      tabs.clear();
    },
  };

  async function check(): Promise<void> {
    const [entries, muted] = await Promise.all([
      attention.list(),
      settings.mutedProjects(),
    ]);
    const previous = seen;
    seen = new Set(entries.map((entry) => entry.id));
    if (previous === null) return;
    const focused = new Set(
      [...tabs.values()].map((tab) => tab.focus).filter((id) => id !== null),
    );
    batcher.push(
      entries.filter(
        (entry) =>
          !previous.has(entry.id) &&
          !muted.has(entry.projectId) &&
          (entry.runId === null || !focused.has(entry.runId)),
      ),
    );
  }
}
