import { afterEach, expect, test, vi } from 'vitest';

import type { AttentionEntry } from './attention';
import {
  alertFor,
  connectNotifications,
  type NotificationApi,
  type NotificationSocket,
} from './notifications';

afterEach(() => {
  window.location.hash = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function entry(id: string, title: string): AttentionEntry {
  return {
    agentName: 'Storm',
    id,
    itemId: null,
    kind: 'question',
    projectId: 'p1',
    projectName: 'Atlas',
    runId: id,
    since: '2026-10-04T14:00:00.000Z',
    title,
  };
}

class FakeSocket implements NotificationSocket {
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function fakeApi(permission: NotificationApi['permission'] = 'granted') {
  const shown: {
    body: string;
    onClick: () => void;
    tag: string;
    title: string;
  }[] = [];
  const api: NotificationApi = {
    permission,
    requestPermission: async () => permission,
    show: (title, { body, tag }, onClick) => {
      shown.push({ body, onClick, tag, title });
    },
  };
  return { api, shown };
}

function connect(api: NotificationApi) {
  const sockets: FakeSocket[] = [];
  const onPush = vi.fn();
  const onOpenEntry = vi.fn();
  const onOpenPanel = vi.fn();
  const disconnect = connectNotifications({
    notificationApi: api,
    onOpenEntry,
    onOpenPanel,
    onPush,
    reconnectMs: 5_000,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { disconnect, onOpenEntry, onOpenPanel, onPush, sockets };
}

test('a batch alert says how many things need attention and names up to three', () => {
  expect(alertFor([entry('a', 'One')]).title).toBe(
    '1 thing needs your attention in Cerebra',
  );
  const batch = alertFor([
    entry('c', 'Three'),
    entry('a', 'One'),
    entry('b', 'Two'),
    entry('d', 'Four'),
  ]);
  expect(batch.title).toBe('4 things need your attention in Cerebra');
  expect(batch.body).toBe('Three\nOne\nTwo');
  expect(batch.tag).toBe(
    alertFor([entry('d', ''), entry('b', ''), entry('a', ''), entry('c', '')])
      .tag,
  );
});

test('a push raises one browser alert and tells the page', () => {
  const { api, shown } = fakeApi();
  const { onPush, sockets } = connect(api);
  const batch = [entry('a', 'One'), entry('b', 'Two'), entry('c', 'Three')];

  sockets[0]!.emit('message', {
    data: JSON.stringify({ entries: batch, type: 'push' }),
  });

  expect(onPush).toHaveBeenCalledWith(batch);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe('3 things need your attention in Cerebra');
});

test('selecting a single alert opens its entry; a batch opens the panel', () => {
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  const { api, shown } = fakeApi();
  const { onOpenEntry, onOpenPanel, sockets } = connect(api);
  const single = entry('a', 'One');

  sockets[0]!.emit('message', {
    data: JSON.stringify({ entries: [single], type: 'push' }),
  });
  sockets[0]!.emit('message', {
    data: JSON.stringify({
      entries: [entry('b', 'Two'), entry('c', 'Three')],
      type: 'push',
    }),
  });
  shown[0]!.onClick();
  shown[1]!.onClick();

  expect(focus).toHaveBeenCalledTimes(2);
  expect(onOpenEntry).toHaveBeenCalledWith(single);
  expect(onOpenPanel).toHaveBeenCalledTimes(1);
});

test('without permission a push still reaches the page but raises no alert', () => {
  const { api, shown } = fakeApi('denied');
  const { onPush, sockets } = connect(api);
  sockets[0]!.emit('message', {
    data: JSON.stringify({ entries: [entry('a', 'One')], type: 'push' }),
  });
  expect(onPush).toHaveBeenCalled();
  expect(shown).toHaveLength(0);
});

test('the focused chat is reported when connected and when it changes', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  window.location.hash = '#/conversations/run-7';
  const { api } = fakeApi();
  const { disconnect, sockets } = connect(api);

  sockets[0]!.emit('open');
  expect(sockets[0]!.sent).toEqual([{ runId: 'run-7', type: 'focus' }]);

  window.location.hash = '#/settings/notifications';
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(sockets[0]!.sent.at(-1)).toEqual({ runId: null, type: 'focus' });

  window.location.hash = '#/conversations/run-8';
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  window.dispatchEvent(new Event('blur'));
  expect(sockets[0]!.sent.at(-1)).toEqual({ runId: null, type: 'focus' });

  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  window.dispatchEvent(new Event('focus'));
  expect(sockets[0]!.sent.at(-1)).toEqual({ runId: 'run-8', type: 'focus' });

  disconnect();
  expect(sockets[0]!.closed).toBe(true);
});

test('a dropped connection is opened again, and not after disconnecting', () => {
  vi.useFakeTimers();
  const { api } = fakeApi();
  const { disconnect, sockets } = connect(api);

  sockets[0]!.emit('close');
  vi.advanceTimersByTime(5_000);
  expect(sockets).toHaveLength(2);

  disconnect();
  sockets[1]!.emit('close');
  vi.advanceTimersByTime(5_000);
  expect(sockets).toHaveLength(2);
});
