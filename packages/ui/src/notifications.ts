import type { AttentionEntry } from './attention';

export interface NotificationSocket {
  addEventListener(
    type: 'close' | 'message' | 'open',
    listener: (event: { data?: unknown }) => void,
  ): void;
  close(): void;
  send(data: string): void;
}

export type NotificationPermissionState =
  'default' | 'denied' | 'granted' | 'unsupported';

export interface NotificationApi {
  readonly permission: NotificationPermissionState;
  requestPermission(): Promise<NotificationPermissionState>;
  show(
    title: string,
    options: { readonly body: string; readonly tag: string },
    onClick: () => void,
  ): void;
}

/** The browser's Notification API, or an unsupported stand-in where there is none. */
export function browserNotificationApi(): NotificationApi {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return {
      permission: 'unsupported',
      requestPermission: async () => 'unsupported',
      show: () => {},
    };
  }
  return {
    get permission() {
      return window.Notification.permission;
    },
    requestPermission: () => window.Notification.requestPermission(),
    show(title, { body, tag }, onClick) {
      const alert = new window.Notification(title, { body, tag });
      alert.addEventListener('click', () => {
        alert.close();
        onClick();
      });
    },
  };
}

export interface Alert {
  readonly body: string;
  readonly tag: string;
  readonly title: string;
}

export function alertFor(entries: readonly AttentionEntry[]): Alert {
  const count = entries.length;
  return {
    body: entries
      .slice(0, 3)
      .map((entry) => entry.title)
      .join('\n'),
    // The same batch reaches every open tab; one tag lets the browser show it once.
    tag: `cerebra:${entries
      .map((entry) => entry.id)
      .sort()
      .join(',')}`,
    title:
      count === 1
        ? '1 thing needs your attention in Cerebra'
        : `${count} things need your attention in Cerebra`,
  };
}

function focusedRun(): string | null {
  if (!document.hasFocus()) return null;
  return /^#\/conversations\/([^/?]+)/.exec(window.location.hash)?.[1] ?? null;
}

export interface ConnectNotificationsOptions {
  readonly notificationApi?: NotificationApi;
  readonly onOpenEntry: (entry: AttentionEntry) => void;
  readonly onOpenPanel: () => void;
  readonly onPush: (entries: readonly AttentionEntry[]) => void;
  readonly reconnectMs?: number;
  readonly socketFactory?: () => NotificationSocket;
}

function browserSocket(): NotificationSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(
    `${protocol}://${window.location.host}/ws/notifications`,
  ) as NotificationSocket;
}

/**
 * Listens for the backend's pushes, raises one browser alert per batch, and
 * tells the backend which chat this tab has in front of the navigator.
 */
export function connectNotifications({
  notificationApi = browserNotificationApi(),
  onOpenEntry,
  onOpenPanel,
  onPush,
  reconnectMs = 5_000,
  socketFactory = browserSocket,
}: ConnectNotificationsOptions): () => void {
  let socket: NotificationSocket | null = null;
  let open = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function reportFocus(): void {
    if (socket === null || !open) return;
    socket.send(JSON.stringify({ runId: focusedRun(), type: 'focus' }));
  }

  function alert(entries: readonly AttentionEntry[]): void {
    if (notificationApi.permission !== 'granted' || entries.length === 0) {
      return;
    }
    const { body, tag, title } = alertFor(entries);
    notificationApi.show(title, { body, tag }, () => {
      window.focus();
      if (entries.length === 1) onOpenEntry(entries[0]!);
      else onOpenPanel();
    });
  }

  function start(): void {
    const current = socketFactory();
    socket = current;
    open = false;
    current.addEventListener('open', () => {
      open = true;
      reportFocus();
    });
    current.addEventListener('message', (event) => {
      let message: { entries?: AttentionEntry[]; type?: string };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.type !== 'push' || !Array.isArray(message.entries)) return;
      onPush(message.entries);
      alert(message.entries);
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      socket = null;
      open = false;
      if (!stopped) retry = setTimeout(start, reconnectMs);
    });
  }

  window.addEventListener('hashchange', reportFocus);
  window.addEventListener('focus', reportFocus);
  window.addEventListener('blur', reportFocus);
  start();

  return () => {
    stopped = true;
    clearTimeout(retry);
    window.removeEventListener('hashchange', reportFocus);
    window.removeEventListener('focus', reportFocus);
    window.removeEventListener('blur', reportFocus);
    socket?.close();
    socket = null;
  };
}
