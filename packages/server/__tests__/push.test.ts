import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FeedListener, JsonObject } from '../src/feed.ts';
import { PushNotifier, type PushMessage } from '../src/push.ts';
import type { PairedDevice, PushRegistration } from '../src/registry.ts';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const TOKEN = 'ExponentPushToken[phone-a]';

interface Expo {
  sent: PushMessage[][];
  receiptQueries: string[][];
  tickets: (messages: PushMessage[]) => unknown[];
  receipts: Record<string, unknown>;
}

let http: Server;
let expo: Expo;
let endpoint: string;

beforeEach(async () => {
  expo = {
    sent: [],
    receiptQueries: [],
    tickets: (messages) => messages.map((_, i) => ({ status: 'ok', id: `t${i}` })),
    receipts: {},
  };
  http = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const parsed = JSON.parse(body);
      let data: unknown;
      if (request.url?.endsWith('/send')) {
        expo.sent.push(parsed);
        data = expo.tickets(parsed);
      } else {
        expo.receiptQueries.push(parsed.ids);
        data = expo.receipts;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}/--/api/v2/push`;
});

afterEach(async () => {
  await new Promise((resolve) => http.close(resolve));
});

const registration = (extra: Partial<PushRegistration> = {}): PushRegistration => ({
  token: TOKEN,
  events: ['build-failed', 'log-errors', 'disk', 'app-stopped', 'slow-build'],
  agentOnly: false,
  ref: 'mac-1',
  registeredAt: new Date(T0).toISOString(),
  ...extra,
});

const device = (push?: PushRegistration): PairedDevice => ({
  id: 'd1',
  name: 'Phone',
  tokenHash: 'h',
  identity: { kind: 'local' },
  pairedAt: '',
  lastSeenAt: null,
  capabilities: ['read'],
  ...(push ? { push } : {}),
});

function failed(finishedAt: string) {
  return {
    ios: {
      platform: 'ios',
      status: 'failed',
      cacheHit: false,
      cacheSkipped: false,
      durationMs: 1000,
      fingerprint: null,
      startedAt: finishedAt,
      finishedAt,
      errorCode: 'STIM_BUILD_FAILED',
    },
  };
}

const env = (extra: JsonObject = {}): JsonObject => ({
  path: '/u/app/.worktrees/login',
  live: true,
  memoryMb: 0,
  warnings: [],
  worktree: { path: '/u/app/.worktrees/login', branch: 'feat/login', repository: '/u/app' },
  ...extra,
});

const status = (...environments: JsonObject[]): JsonObject => ({ environments, unprovisionedWorktrees: [] });

function setup(options: { devices?: PairedDevice[] } = {}) {
  let listener: FeedListener | null = null;
  let freeGb = 200;
  let now = T0;
  let devices = options.devices ?? [device(registration())];
  const dropped: string[] = [];
  const subscriptions = { opened: 0, closed: 0 };
  const notifier = new PushNotifier({
    name: 'MacBook Pro',
    endpoint,
    subscribeStatus: (next) => {
      listener = next;
      subscriptions.opened++;
      return () => {
        listener = null;
        subscriptions.closed++;
      };
    },
    readVolumes: () => [{ mount: '/', holds: [], freeBytes: freeGb * 1e9, totalBytes: 1e12 }],
    devices: () => devices,
    dropToken: (token) => dropped.push(token),
    limits: { receiptDelayMs: 0, diskMs: 10 },
    now: () => now,
  });
  notifier.refresh();
  return {
    notifier,
    dropped,
    subscriptions,
    at: (ms: number) => (now = T0 + ms),
    setFreeGb: (gb: number) => (freeGb = gb),
    emit: (value: JsonObject) => listener!.item(value, JSON.stringify(value)),
    setDevices: (next: PairedDevice[]) => {
      devices = next;
      notifier.refresh();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Waits until `pushes` messages reached the fake Expo, then a little longer to catch extra ones. */
async function settle(pushes = 0): Promise<void> {
  for (let i = 0; i < 500 && expo.sent.flat().length < pushes; i++) await tick();
  for (let i = 0; i < 5; i++) await tick();
}

const bodies = () => expo.sent.flat().map((m) => `${m.title} | ${m.body}`);

describe('PushNotifier', () => {
  let current: ReturnType<typeof setup> | null = null;
  afterEach(() => current?.notifier.close());

  it('stays quiet about what is wrong when it starts, then pushes each new failure once', async () => {
    const t = (current = setup());
    t.emit(status(env({ lastBuilds: failed('2026-09-26T11:59:00Z') })));
    await settle();
    expect(expo.sent).toEqual([]);

    t.at(60_000);
    t.emit(status(env({ lastBuilds: failed('2026-09-26T12:00:30Z') })));
    t.emit(status(env({ lastBuilds: failed('2026-09-26T12:00:30Z') })));
    await settle(1);
    expect(expo.sent).toEqual([
      [
        {
          to: TOKEN,
          title: 'feat/login',
          subtitle: 'MacBook Pro',
          body: 'iOS build failed (STIM_BUILD_FAILED)',
          sound: 'default',
          data: { ref: 'mac-1', target: 'workspace', path: '/u/app/.worktrees/login' },
        },
      ],
    ]);
  });

  it('pushes log errors once they settle, then new ones after a cooldown', async () => {
    const t = (current = setup());
    t.emit(status(env()));
    t.at(1000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 2 } })));
    t.at(5000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 3 } })));
    t.at(14_000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 3 } })));
    t.at(16_000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 3 } })));
    await settle(1);
    expect(bodies()).toEqual(['feat/login | 3 errors in the logs']);
    expect(expo.sent[0]![0]!.data).toEqual({ ref: 'mac-1', target: 'logs', path: '/u/app/.worktrees/login' });

    t.at(60_000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 7 } })));
    t.at(200_000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 7 } })));
    await settle();
    expect(bodies()).toHaveLength(1);

    t.at(320_000);
    t.emit(status(env({ logs: { dir: '/l', errorsSinceMarker: 7 } })));
    await settle(2);
    expect(bodies()).toEqual(['feat/login | 3 errors in the logs', 'feat/login | 4 new errors in the logs']);
  });

  it('pushes low disk once, to the machine sheet, and only the events the device chose', async () => {
    const t = (current = setup({ devices: [device(registration({ events: ['disk'] }))] }));
    const stopped = { name: 'stim-x (iPhone 18 Pro 27.0)', udid: 'U', owned: true, state: 'Booted' };
    t.emit(status(env({ ios: { ...stopped, app: { id: 'a', state: 'running' } } })));
    t.at(1000);
    t.emit(status(env({ ios: { ...stopped, app: { id: 'a', state: 'stopped' } } })));
    t.setFreeGb(3);
    await settle();
    t.emit(status(env({ ios: { ...stopped, app: { id: 'a', state: 'stopped' } } })));
    await settle(1);
    expect(expo.sent).toEqual([
      [
        {
          to: TOKEN,
          title: 'MacBook Pro',
          body: "3.0 GB free, below Stim's floor",
          sound: 'default',
          data: { ref: 'mac-1', target: 'machine' },
        },
      ],
    ]);
  });

  it('leaves out workspaces no agent drives when the device asks', async () => {
    const t = (current = setup({ devices: [device(registration({ agentOnly: true }))] }));
    const sim = (state: 'driven' | 'idle') => ({
      ios: {
        name: 'stim-x (iPhone 18 Pro 27.0)',
        udid: 'U',
        owned: true,
        state: 'Booted',
        activity: { state, basis: [] },
        app: { id: 'a', state: 'stopped' },
      },
    });
    t.emit(status(env(), env({ path: '/u/app/.worktrees/agent', worktree: undefined })));
    t.at(1000);
    t.emit(status(env(sim('idle')), env({ path: '/u/app/.worktrees/agent', worktree: undefined, ...sim('driven') })));
    await settle(1);
    expect(bodies()).toEqual(['agent | App not running on iPhone 18 Pro 27.0']);
  });

  it('sums up more than three problems in one push', async () => {
    const t = (current = setup());
    t.emit(status());
    t.at(1000);
    const broken = (name: string) =>
      env({ path: `/u/app/.worktrees/${name}`, worktree: undefined, lastBuilds: failed('2026-09-26T12:00:00Z') });
    t.emit(status(broken('a'), broken('b'), broken('c'), broken('d')));
    await settle(1);
    expect(expo.sent).toEqual([
      [
        {
          to: TOKEN,
          title: 'MacBook Pro',
          body: '4 problems need attention',
          sound: 'default',
          data: { ref: 'mac-1', target: 'home' },
        },
      ],
    ]);
  });

  it('drops a token the push service no longer delivers to, from a ticket or a receipt', async () => {
    const t = (current = setup({
      devices: [device(registration()), { ...device(registration({ token: 'ExponentPushToken[phone-b]' })), id: 'd2' }],
    }));
    expo.tickets = (messages) =>
      messages.map((m, i) =>
        m.to === TOKEN
          ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: `t${i}` },
      );
    expo.receipts = { t1: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } };
    t.emit(status());
    t.at(1000);
    t.emit(status(env({ lastBuilds: failed('2026-09-26T12:00:00Z') })));
    for (let i = 0; i < 500 && t.dropped.length < 2; i++) await tick();
    expect(expo.receiptQueries).toEqual([['t1']]);
    expect(t.dropped).toEqual([TOKEN, 'ExponentPushToken[phone-b]']);
  });

  it('holds a status subscription only while a device is registered', () => {
    const t = (current = setup({ devices: [device()] }));
    expect(t.subscriptions).toEqual({ opened: 0, closed: 0 });
    t.setDevices([device(registration())]);
    expect(t.subscriptions).toEqual({ opened: 1, closed: 0 });
    t.setDevices([device()]);
    expect(t.subscriptions).toEqual({ opened: 1, closed: 1 });
  });

  it('stops pushing to a device past its hourly budget', async () => {
    const t = (current = setup());
    t.emit(status());
    for (let i = 1; i <= 25; i++) {
      t.at(i * 1000);
      t.emit(status(env({ lastBuilds: failed(new Date(T0 + i * 1000).toISOString()) })));
    }
    await settle(20);
    expect(expo.sent.flat()).toHaveLength(20);
  });
});
