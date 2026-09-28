import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedListener, JsonObject } from '../src/feed.ts';
import { NotificationLog, type LoggedNotification } from '../src/notification-log.ts';
import {
  maskPushTokens,
  PushNotifier,
  type PushLimits,
  type PushMessage,
  type PushNotifierOptions,
} from '../src/push.ts';
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
let logDir: string;

beforeEach(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'stim-push-log-'));
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
  rmSync(logDir, { recursive: true, force: true });
});

const registration = (extra: Partial<PushRegistration> = {}): PushRegistration => ({
  token: TOKEN,
  events: ['started', 'stuck', 'looping', 'finished', 'machine', 'control'],
  ref: 'mac-1',
  registeredAt: new Date(T0).toISOString(),
  stuckMinutes: 15,
  quietHours: null,
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

/** A history of `count` iOS builds that failed the same way, the newest at `at`. */
function looping(at: number, count = 3): JsonObject {
  const runs = Array.from({ length: count }, (_, i) => ({
    platform: 'ios',
    status: 'failed',
    result: 'failed',
    cacheHit: false,
    cacheSkipped: false,
    durationMs: 1000,
    fingerprint: null,
    startedAt: new Date(at - i * 60_000).toISOString(),
    finishedAt: new Date(at - i * 60_000).toISOString(),
    errorCode: 'STIM_BUILD_FAILED',
    diagnostics: [{ file: '/u/app/ios/AppDelegate.swift', line: 71, column: 3, message: 'boom' }],
  }));
  return { builds: { ios: runs }, lastBuilds: { ios: runs[0] } };
}

const env = (extra: JsonObject = {}): JsonObject => ({
  path: '/u/app/.worktrees/login',
  live: true,
  memoryMb: 0,
  warnings: [],
  worktree: {
    path: '/u/app/.worktrees/login',
    branch: 'feat/login',
    repository: '/u/app',
    git: { changed: 0, untracked: 0, upstream: 'origin/feat/login', ahead: 0, behind: 0, mergedInto: null },
  },
  ...extra,
});

const driven = (lastAt: number) => ({
  ios: {
    name: 'stim-x (iPhone 18 Pro 27.0)',
    udid: 'U',
    owned: true,
    state: 'Booted',
    activity: {
      state: 'driven',
      driver: { tool: 'agent-device', pid: 1, since: new Date(lastAt).toISOString() },
      lastActivityAt: new Date(lastAt).toISOString(),
      basis: ['agent-device-claim'],
    },
  },
});

const status = (...environments: JsonObject[]): JsonObject => ({ environments, unprovisionedWorktrees: [] });

interface Setup {
  limits?: Partial<PushLimits>;
  devices?: PairedDevice[];
  replay?: JsonObject;
  freeGb?: number;
  pullRequests?: PushNotifierOptions['pullRequests'];
}

function setup(options: Setup = {}) {
  let listener: FeedListener | null = null;
  let freeGb = options.freeGb ?? 200;
  let now = T0;
  let devices = options.devices ?? [device(registration())];
  const dropped: string[] = [];
  const subscriptions = { opened: 0, closed: 0 };
  const log = new NotificationLog(join(logDir, 'notifications.json'), () => now);
  const logged: LoggedNotification[] = [];
  const notifier = new PushNotifier({
    name: 'MacBook Pro',
    endpoint,
    subscribeStatus: (next) => {
      listener = next;
      subscriptions.opened++;
      if (options.replay) next.item(options.replay, JSON.stringify(options.replay));
      return () => {
        listener = null;
        subscriptions.closed++;
      };
    },
    readVolumes: () => [{ mount: '/', holds: [], freeBytes: freeGb * 1e9, totalBytes: 1e12 }],
    readPressure: async () => 'normal',
    pullRequests: options.pullRequests ?? (async () => new Map()),
    ownLeases: () => [],
    devices: () => devices,
    dropToken: (token) => dropped.push(token),
    log,
    whilePaired: true,
    logged: (entries) => logged.push(...entries),
    limits: { receiptDelayMs: 0, diskMs: 10, ...options.limits },
    now: () => now,
  });
  notifier.refresh();
  return {
    notifier,
    dropped,
    subscriptions,
    log,
    logged,
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

  it('stays quiet about what is true when it starts, then pushes a looping build once, to its build details', async () => {
    const t = (current = setup());
    t.emit(status(env(looping(T0 - 60_000))));
    await settle();
    expect(expo.sent).toEqual([]);

    t.at(60_000);
    t.emit(status(env(looping(T0 + 30_000, 1))));
    t.at(120_000);
    t.emit(status(env(looping(T0 + 90_000))));
    t.emit(status(env(looping(T0 + 90_000))));
    t.at(180_000);
    t.emit(status(env(looping(T0 + 150_000, 4))));
    await settle(1);
    expect(expo.sent).toEqual([
      [
        {
          to: TOKEN,
          title: 'feat/login',
          subtitle: 'MacBook Pro',
          body: 'Same Swift error 3x at AppDelegate.swift:71',
          sound: 'default',
          interruptionLevel: 'active',
          channelId: 'attention',
          collapseId: expect.stringMatching(/^[0-9a-f]{32}$/),
          data: { ref: 'mac-1', notification: 1, target: 'build', path: '/u/app/.worktrees/login', platform: 'ios' },
        },
      ],
    ]);
  });

  it('pushes work started quietly, grouped per machine, and a stuck agent after the chosen threshold', async () => {
    const t = (current = setup({ devices: [device(registration({ stuckMinutes: 5 }))] }));
    t.emit(status());
    t.at(1000);
    t.emit(status(env(driven(T0 + 1000))));
    await settle(1);
    expect(expo.sent.flat()[0]).toMatchObject({
      body: 'agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro',
      sound: null,
      interruptionLevel: 'passive',
      channelId: 'updates',
      threadId: 'started:MacBook Pro',
      data: { target: 'device', path: '/u/app/.worktrees/login', platform: 'ios', slot: 'default' },
    });
    t.at(5 * 60_000);
    t.emit(status(env(driven(T0 + 1000))));
    t.at(5 * 60_000 + 2000);
    t.emit(status(env(driven(T0 + 1000))));
    await settle(2);
    expect(bodies()).toEqual([
      'feat/login | agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro',
      'feat/login | No agent activity for 5 min; iPhone 18 Pro 27.0 still up',
    ]);
    const [started, stuck] = expo.sent.flat();
    expect(started!.collapseId).not.toBe(stuck!.collapseId);
  });

  it('no longer pushes a failed build, log errors, a stopped app or a slow build', async () => {
    const t = (current = setup());
    t.emit(status(env()));
    t.at(60_000);
    t.emit(
      status(
        env({
          ...looping(T0 + 30_000, 1),
          logs: { dir: '/l', errorsSinceMarker: 9 },
          build: {
            platform: 'android',
            slot: 'default',
            state: 'running',
            phase: 'compile',
            startedAt: new Date(T0 - 3_600_000).toISOString(),
            phaseStartedAt: new Date(T0 - 3_600_000).toISOString(),
            outcome: 'cold',
            expectedMs: 60_000,
            expectedPhaseMs: null,
            basis: 3,
          },
          ios: {
            name: 'stim-x (iPhone 18 Pro 27.0)',
            udid: 'U',
            owned: true,
            state: 'Booted',
            app: { id: 'a', state: 'stopped' },
          },
        }),
      ),
    );
    await settle();
    expect(expo.sent).toEqual([]);
  });

  it('pushes low disk once, to the machine sheet, and only the events the device chose', async () => {
    const t = (current = setup({ devices: [device(registration({ events: ['machine'] }))] }));
    t.emit(status(env()));
    t.at(1000);
    t.emit(status(env({ ...driven(T0 + 1000), ...looping(T0 + 1000) })));
    t.setFreeGb(3);
    await settle();
    t.emit(status(env({ ...driven(T0 + 1000), ...looping(T0 + 1000) })));
    await settle(1);
    expect(expo.sent).toEqual([
      [
        {
          to: TOKEN,
          title: 'MacBook Pro',
          body: "3.0 GB free, below Stim's floor",
          sound: 'default',
          interruptionLevel: 'active',
          channelId: 'attention',
          collapseId: expect.any(String),
          data: { ref: 'mac-1', notification: expect.any(Number), target: 'machine' },
        },
      ],
    ]);
  });

  it('holds pushes during the quiet hours of the phone', async () => {
    const quietHours = { start: 11 * 60, end: 13 * 60, timeZone: 'UTC' };
    const t = (current = setup({ devices: [device(registration({ quietHours }))] }));
    t.emit(status(env()));
    t.at(1000);
    t.emit(status(env(looping(T0 + 1000))));
    await settle();
    expect(expo.sent).toEqual([]);
    t.at(3_600_000);
    t.emit(status(env(looping(T0 + 1000))));
    await settle(1);
    expect(bodies()).toEqual(['feat/login | Same Swift error 3x at AppDelegate.swift:71']);
  });

  it("looks up the pushed worktrees' pull requests and pushes one that became ready for review", async () => {
    const asked: string[][] = [];
    let draft = true;
    const t = (current = setup({
      pullRequests: async (worktrees) => {
        asked.push(worktrees.map((w) => `${w.path} ${w.branch} ${w.repository}`));
        return new Map([
          ['/u/app/.worktrees/login', { number: 9, state: 'open', draft, url: 'https://github.com/o/r/pull/9' }],
        ]);
      },
    }));
    const local = env({
      path: '/u/app/.worktrees/local',
      worktree: {
        path: '/u/app/.worktrees/local',
        branch: 'local',
        repository: '/u/app',
        git: { upstream: null, mergedInto: null },
      },
    });
    t.emit(status(env(), local));
    for (let i = 0; i < 100 && asked.length < 1; i++) await tick();
    await tick();
    expect(asked).toEqual([['/u/app/.worktrees/login feat/login /u/app']]);
    draft = false;
    await (t.notifier as unknown as { lookUpPullRequests: () => Promise<void> }).lookUpPullRequests();
    await settle(1);
    expect(expo.sent.flat().map((m) => [m.body, m.data])).toEqual([
      [
        'PR #9 is ready for review',
        {
          ref: 'mac-1',
          notification: 1,
          target: 'url',
          path: '/u/app/.worktrees/login',
          url: 'https://github.com/o/r/pull/9',
        },
      ],
    ]);
  });

  it('pushes a control conflict only to a device that registered for it', async () => {
    const t = (current = setup({
      devices: [
        device(registration()),
        { ...device(registration({ token: 'ExponentPushToken[phone-b]', events: ['stuck'] })), id: 'd2' },
      ],
    }));
    t.emit(status());
    const conflict = {
      workspace: '/w',
      title: 'feat/login',
      body: 'iPad took over',
      platform: 'ios' as const,
      slot: 'default',
    };
    t.notifier.control('d1', conflict);
    t.notifier.control('d2', conflict);
    await settle(1);
    expect(expo.sent.flat().map((m) => [m.to, m.body, m.data])).toEqual([
      [
        TOKEN,
        'iPad took over',
        { ref: 'mac-1', notification: 1, target: 'device', path: '/w', platform: 'ios', slot: 'default' },
      ],
    ]);
    expect(t.log.list('d1').notifications.map((n) => [n.seq, n.suppressed])).toEqual([[1, undefined]]);
    expect(t.log.list('d2').notifications.map((n) => [n.seq, n.suppressed])).toEqual([[2, 'muted']]);
  });

  it('sums up more than three notifications in one push', async () => {
    const t = (current = setup());
    t.emit(status());
    t.at(1000);
    const broken = (name: string) =>
      env({ path: `/u/app/.worktrees/${name}`, worktree: undefined, ...looping(T0 + 1000) });
    t.emit(status(broken('a'), broken('b'), broken('c'), broken('d')));
    await settle(1);
    expect(expo.sent).toEqual([
      [
        {
          to: TOKEN,
          title: 'MacBook Pro',
          body: '4 things need a look',
          sound: 'default',
          interruptionLevel: 'active',
          channelId: 'attention',
          data: { ref: 'mac-1', target: 'home' },
        },
      ],
    ]);
  });

  it('delivers each event at the level the device chose, a summary of silent ones silently too', async () => {
    const t = (current = setup({
      devices: [device(registration({ stuckMinutes: 5, levels: { started: 'alert', looping: 'silent' } }))],
    }));
    t.emit(status());
    t.at(1000);
    t.emit(status(env(driven(T0 + 1000))));
    t.at(2000);
    t.emit(status(env({ ...driven(T0 + 1000), ...looping(T0 + 2000) })));
    t.notifier.control('d1', {
      workspace: '/w',
      title: 'feat/login',
      body: 'iPad took over',
      platform: 'ios',
      slot: 'default',
    });
    await settle(3);
    expect(expo.sent.flat().map((m) => [m.body, m.sound, m.interruptionLevel, m.channelId])).toEqual([
      ['agent-device started driving iPhone 18 Pro 27.0 on MacBook Pro', 'default', 'active', 'attention'],
      ['Same Swift error 3x at AppDelegate.swift:71', null, 'passive', 'updates'],
      ['iPad took over', 'default', 'active', 'attention'],
    ]);

    expo.sent = [];
    t.at(3000);
    const broken = (name: string) =>
      env({ path: `/u/app/.worktrees/${name}`, worktree: undefined, ...looping(T0 + 3000) });
    t.emit(status(broken('a'), broken('b'), broken('c'), broken('d')));
    await settle(1);
    expect(expo.sent.flat().map((m) => [m.body, m.sound, m.interruptionLevel, m.channelId])).toEqual([
      ['4 things need a look', null, 'passive', 'updates'],
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
    t.emit(status(env(looping(T0 + 1000))));
    for (let i = 0; i < 500 && t.dropped.length < 2; i++) await tick();
    expect(expo.receiptQueries).toEqual([['t1']]);
    expect(t.dropped).toEqual([TOKEN, 'ExponentPushToken[phone-b]']);
  });

  it('logs refused tickets and failed receipts without the push token', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const t = (current = setup());
      expo.tickets = () => [
        { status: 'error', message: `"${TOKEN}" is not a valid Expo push token`, details: { error: 'InvalidToken' } },
      ];
      t.emit(status());
      t.at(1000);
      t.emit(status(env(looping(T0 + 1000))));
      for (let i = 0; i < 500 && logged.mock.calls.length < 1; i++) await tick();
      expo.tickets = () => [{ status: 'ok', id: 't0' }];
      expo.receipts = { t0: { status: 'error', message: `Rate exceeded for ${TOKEN}` } };
      t.at(2000);
      t.emit(status(env({ path: '/u/app/.worktrees/other', worktree: undefined, ...looping(T0 + 2000) })));
      for (let i = 0; i < 500 && logged.mock.calls.length < 2; i++) await tick();
      const lines = logged.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual([
        `stim-server: Expo refused a push: "${maskPushTokens(TOKEN)}" is not a valid Expo push token`,
        `stim-server: a push failed: Rate exceeded for ${maskPushTokens(TOKEN)}`,
      ]);
      for (const line of lines) expect(line).not.toContain('phone-a');
    } finally {
      logged.mockRestore();
    }
  });

  it('stays quiet about low disk that a replayed status found at registration', async () => {
    const t = (current = setup({ replay: status(env()), freeGb: 3 }));
    t.at(90_000);
    t.emit(status(env()));
    await settle();
    expect(expo.sent).toEqual([]);
  });

  it('pushes a looping build that arrives right after another device registers', async () => {
    const t = (current = setup());
    t.emit(status(env()));
    t.at(1000);
    t.setDevices([
      device(registration()),
      { ...device(registration({ token: 'ExponentPushToken[phone-b]' })), id: 'd2' },
    ]);
    t.emit(status(env(looping(T0 + 1000))));
    await settle(2);
    expect(expo.sent.flat().map((m) => m.to)).toEqual([TOKEN, 'ExponentPushToken[phone-b]']);
  });

  it('holds a status subscription only while a device is paired', () => {
    const t = (current = setup({ devices: [] }));
    expect(t.subscriptions).toEqual({ opened: 0, closed: 0 });
    t.setDevices([device()]);
    expect(t.subscriptions).toEqual({ opened: 1, closed: 0 });
    t.setDevices([device(registration())]);
    expect(t.subscriptions).toEqual({ opened: 1, closed: 0 });
    t.setDevices([]);
    expect(t.subscriptions).toEqual({ opened: 1, closed: 1 });
  });

  it('logs a stuck agent at the threshold of the phones that want stuck, not of the others', async () => {
    const t = (current = setup({
      devices: [
        device(registration({ events: ['machine'], stuckMinutes: 5 })),
        { ...device(registration({ token: 'ExponentPushToken[phone-b]', stuckMinutes: 30 })), id: 'd2' },
      ],
    }));
    t.emit(status());
    t.at(1000);
    t.emit(status(env(driven(T0 + 1000))));
    t.at(6 * 60_000);
    t.emit(status(env(driven(T0 + 1000))));
    expect(t.logged.map((n) => n.category)).toEqual(['started']);
    t.at(31 * 60_000);
    t.emit(status(env(driven(T0 + 1000))));
    expect(t.logged.map((n) => [n.category, n.suppressed])).toEqual([
      ['started', undefined],
      ['stuck', undefined],
    ]);
    await settle(2);
  });

  it('logs what no phone is pushed, marking what a muted category or quiet hours held back', async () => {
    const t = (current = setup({ devices: [device()] }));
    t.emit(status(env()));
    t.at(1000);
    t.emit(status(env(looping(T0 + 1000))));
    t.setDevices([device(registration({ events: ['machine'] }))]);
    t.at(2000);
    t.emit(status(env(looping(T0 + 1000)), env({ path: '/u/b', worktree: undefined, ...looping(T0 + 2000) })));
    const quietHours = { start: 11 * 60, end: 13 * 60, timeZone: 'UTC' };
    t.setDevices([device(registration({ quietHours }))]);
    t.at(3000);
    t.emit(status(env({ path: '/u/c', worktree: undefined, ...looping(T0 + 3000) })));
    await settle();
    expect(expo.sent).toEqual([]);
    expect(t.logged.map((n) => [n.seq, n.title, n.body, n.suppressed])).toEqual([
      [1, 'feat/login', 'Same Swift error 3x at AppDelegate.swift:71', undefined],
      [2, 'b', 'Same Swift error 3x at AppDelegate.swift:71', 'muted'],
      [3, 'c', 'Same Swift error 3x at AppDelegate.swift:71', 'quiet-hours'],
    ]);
    expect(t.log.list('d1').notifications.map((n) => n.seq)).toEqual([3, 2, 1]);
  });

  it('keeps quiet pushes out of the hourly budget, so work started cannot crowd out a stuck agent', async () => {
    const t = (current = setup({ limits: { perHour: 1 }, devices: [device(registration({ stuckMinutes: 5 }))] }));
    t.emit(status());
    t.at(1000);
    t.emit(status(env(driven(T0 + 1000))));
    t.at(6 * 60_000);
    t.emit(status(env(driven(T0 + 1000))));
    await settle(2);
    expect(expo.sent.flat().map((m) => m.interruptionLevel)).toEqual(['passive', 'active']);
  });

  it('keeps silent control conflicts out of the hourly budget too', async () => {
    const t = (current = setup({
      limits: { perHour: 1 },
      devices: [device(registration({ levels: { control: 'silent' } }))],
    }));
    t.emit(status());
    for (const slot of ['a', 'b', 'c']) {
      t.notifier.control('d1', { workspace: '/w', title: 'feat/login', body: slot, platform: 'ios', slot });
    }
    await settle(3);
    expect(expo.sent.flat().map((m) => [m.body, m.interruptionLevel])).toEqual([
      ['a', 'passive'],
      ['b', 'passive'],
      ['c', 'passive'],
    ]);
  });

  it('stops pushing to a device past its hourly budget', async () => {
    const t = (current = setup());
    t.emit(status());
    const broken: JsonObject[] = [];
    for (let i = 1; i <= 25; i++) {
      t.at(i * 1000);
      broken.push(env({ path: `/u/app/.worktrees/w${i}`, worktree: undefined, ...looping(T0 + i * 1000) }));
      t.emit(status(...broken));
    }
    await settle(20);
    expect(expo.sent.flat()).toHaveLength(20);
  });
});

describe('maskPushTokens', () => {
  it('replaces every Expo push token with a short hash that still tells devices apart', () => {
    const masked = maskPushTokens(
      'to ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] and ExpoPushToken[yyyyyyyyyyyyyyyyyyyyyy] and ExponentPushToken[zzzz',
    );
    expect(masked).toMatch(
      /^to ExponentPushToken\[#[0-9a-f]{8}\] and ExpoPushToken\[#[0-9a-f]{8}\] and ExponentPushToken\[#[0-9a-f]{8}\]$/,
    );
    expect(masked).not.toMatch(/xxxx|yyyy|zzzz/);
    expect(maskPushTokens('ExponentPushToken[a]')).toBe(maskPushTokens('ExponentPushToken[a]'));
    expect(maskPushTokens('ExponentPushToken[a]')).not.toBe(maskPushTokens('ExponentPushToken[b]'));
  });
});
