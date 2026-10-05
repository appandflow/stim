import { filterRecords, shiftTimestamps, usageHistory } from '../../mobile/mock-server/payloads.mjs';

export interface Frame {
  mime: string;
  width: number;
  height: number;
  data: string;
}

interface Environment {
  path: string;
  recording?: { enabled: boolean };
  ios?: { state?: string };
  android?: { state?: string };
  slots?: Environment[];
}

interface StatusPayload {
  environments: Environment[];
  capacity: { totalMemoryMb: number };
  machine?: { owners?: unknown[] };
}

interface LogRecord {
  ts: number;
}

export interface Fixtures {
  capturedAt: string;
  stimVersion: string;
  home: string;
  status: StatusPayload;
  machineDetails: Record<string, unknown>;
  logs: LogRecord[];
  plans: Record<string, Record<string, unknown>>;
  frames: Record<string, Frame[]>;
}

export interface FixtureFiles {
  status: { capturedAt: string; stimVersion: string; home: string; payload: StatusPayload };
  machineDetails: Record<string, unknown>;
  logs: string;
  plans: Record<string, Record<string, unknown>>;
  frames: Record<string, { meta: Omit<Frame, 'data'>; images: Uint8Array[] }>;
}

export function assembleFixtures(files: FixtureFiles): Fixtures {
  const frames: Record<string, Frame[]> = {};
  for (const [key, { meta, images }] of Object.entries(files.frames)) {
    frames[key] = images.map((image) => ({
      mime: meta.mime,
      width: meta.width,
      height: meta.height,
      data: base64(image),
    }));
  }
  return {
    capturedAt: files.status.capturedAt,
    stimVersion: files.status.stimVersion,
    home: files.status.home,
    status: files.status.payload,
    machineDetails: files.machineDetails,
    logs: files.logs
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogRecord),
    plans: files.plans,
    frames,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export interface Device {
  id: string;
  name: string;
}

export interface Peer {
  send(text: string): void;
  close(): void;
  remember(device: Device): void;
}

type Params = Record<string, unknown>;
type Outcome = { result: unknown } | { error: [string, string] } | { deferred: true };
type Timer = ReturnType<typeof setInterval>;

const PROTOCOL = 1;
const ACTIONS = ['reload', 'stop'];
const ACTION_MS = 800;
const STATUS_MS = 5000;
const LOGS_MS = 2000;
const FRAME_MS = 1000;
const HISTORY_INTERVAL_MS = 5000;
const MINUTE = 60_000;
const GB = 1e9;
const FREE_GB = 212;
const NOTIFICATION_LOG = 'demo';
const CONTROL_PLATFORMS = ['ios', 'android', 'web', 'macos'];
const TOUCH_PHASES = ['down', 'move', 'up'];
const TAP_SLOP = 0.03;
const MAX_DEVICE_NAME = 64;
const SIMULATOR = { canShake: false, slowAnimations: null };
const DEVICE_TOKEN_CONTEXT = 'stim-demo-device:';
const ROOT = '/Users/demo/Developer';

interface FrameFeed {
  connection: DemoConnection;
  subscription: string;
  target: string;
  key: string;
  platform: string;
  slot: string;
}

export class DemoMachine {
  readonly startedAt: number = Date.now();
  readonly shiftMs: number;
  readonly logs: LogRecord[];
  readonly notifications: Record<string, unknown>[];
  recordingEnabled = false;
  readonly busy: Set<string> = new Set();
  readonly screens: Map<string, number> = new Map();
  readonly feeds: Set<FrameFeed> = new Set();
  readonly fixtures: Fixtures;
  readonly name: string;
  private readonly token: string | undefined;

  constructor(fixtures: Fixtures, name: string, token: string | undefined) {
    this.fixtures = fixtures;
    this.name = name;
    this.token = token || undefined;
    this.shiftMs = this.startedAt - Date.parse(fixtures.capturedAt);
    this.logs = fixtures.logs.map((record) => Object.assign({}, record, { ts: record.ts + this.shiftMs }));
    this.notifications = notificationSamples(name)
      .toReversed()
      .map(({ ago, ...rest }, i) =>
        Object.assign({ seq: i + 1, at: new Date(this.startedAt - ago * MINUTE).toISOString() }, rest),
      )
      .toReversed();
  }

  connect(peer: Peer, device: Device | null): DemoConnection {
    return new DemoConnection(this, peer, device);
  }

  status(): StatusPayload {
    const payload = shiftTimestamps(this.fixtures.status, this.shiftMs) as StatusPayload;
    for (const env of payload.environments) env.recording = { enabled: this.recordingEnabled };
    return payload;
  }

  frame(feed: Omit<FrameFeed, 'connection'>): Frame | undefined {
    const screens = this.fixtures.frames[feed.key];
    return screens?.[(this.screens.get(feed.target) ?? 0) % screens.length];
  }

  tap(target: string, key: string): void {
    const count = this.fixtures.frames[key]?.length ?? 0;
    if (count < 2) return;
    this.screens.set(target, ((this.screens.get(target) ?? 0) + 1) % count);
    for (const feed of this.feeds) if (feed.target === target) feed.connection.sendFrame(feed);
  }

  async issueDeviceToken(): Promise<string> {
    const id = base64url(crypto.getRandomValues(new Uint8Array(18)));
    return `${id}.${await this.sign(id)}`;
  }

  async verifyDeviceToken(deviceToken: string): Promise<boolean> {
    const [id, mac, ...rest] = deviceToken.split('.');
    if (!id || !mac || rest.length > 0 || this.token === undefined) return false;
    return constantTimeEqual(mac, await this.sign(id));
  }

  pairingTokenMatches(value: unknown): boolean {
    return typeof value === 'string' && this.token !== undefined && constantTimeEqual(value, this.token);
  }

  private async sign(id: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.token),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(DEVICE_TOKEN_CONTEXT + id));
    return base64url(new Uint8Array(mac));
  }
}

export class DemoConnection {
  private nextSubscription = 1;
  private nextSession = 1;
  private readonly timers = new Map<string, Timer>();
  private readonly sessions = new Map<
    string,
    { target: string; key: string; platform: string; down?: { x: number; y: number } }
  >();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly machine: DemoMachine;
  private readonly peer: Peer;
  private device: Device | null;

  constructor(machine: DemoMachine, peer: Peer, device: Device | null) {
    this.machine = machine;
    this.peer = peer;
    this.device = device;
  }

  receive(text: string): Promise<void> {
    this.queue = this.queue.then(() => this.handle(text)).catch(() => {});
    return this.queue;
  }

  close(): void {
    this.closed = true;
    for (const subscription of this.timers.keys()) this.stop(subscription);
    for (const feed of this.machine.feeds) if (feed.connection === this) this.machine.feeds.delete(feed);
    this.sessions.clear();
  }

  sendFrame(feed: FrameFeed): void {
    const frame = this.machine.frame(feed);
    if (!frame) return;
    this.send({
      event: 'frame',
      subscription: feed.subscription,
      platform: feed.platform,
      slot: feed.slot,
      ...frame,
      capturedAt: new Date().toISOString(),
    });
  }

  private send(message: unknown): void {
    if (!this.closed) this.peer.send(JSON.stringify(message));
  }

  private async handle(text: string): Promise<void> {
    let message: { id?: unknown; method?: unknown; params?: Params };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    const { id, method } = message;
    const params = message.params ?? {};
    const fail = (code: string, description: string): void => this.send({ id, error: { code, message: description } });
    if (typeof method !== 'string') return fail('unknown-method', `Unknown method ${String(method)}.`);
    if (method !== 'hello' && !this.device) return fail('unauthorized', 'Send hello first.');
    let outcome: Outcome;
    try {
      outcome = method === 'hello' ? await this.hello(params) : this.call(method, params, id);
    } catch (error) {
      return fail('bad-request', (error as Error).message);
    }
    if ('error' in outcome) {
      fail(...outcome.error);
      if (method === 'hello') this.peer.close();
      return;
    }
    if ('result' in outcome) this.send({ id, result: outcome.result });
  }

  private async hello(params: Params): Promise<Outcome> {
    if (params.protocol !== PROTOCOL) return { error: ['protocol-unsupported', 'This server speaks protocol 1.'] };
    const auth = (params.auth ?? {}) as Params;
    if (typeof auth.deviceToken === 'string') {
      if (!(await this.machine.verifyDeviceToken(auth.deviceToken))) {
        return { error: ['unauthorized', 'This Mac does not recognize this phone.'] };
      }
      return { result: await this.welcome(auth.deviceToken, 'Phone') };
    }
    if (!this.machine.pairingTokenMatches(auth.pairingToken)) {
      return { error: ['pairing-expired', 'This pairing code was used or expired. Show a new one in Stim Desktop.'] };
    }
    const deviceToken = await this.machine.issueDeviceToken();
    const name = typeof auth.deviceName === 'string' ? auth.deviceName.slice(0, MAX_DEVICE_NAME) : 'Phone';
    return { result: { ...(await this.welcome(deviceToken, name)), deviceToken } };
  }

  private async welcome(deviceToken: string, name: string): Promise<Record<string, unknown>> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceToken));
    this.device = { id: hex(new Uint8Array(digest)).slice(0, 8), name };
    this.peer.remember(this.device);
    const { fixtures } = this.machine;
    return {
      protocol: PROTOCOL,
      server: {
        name: this.machine.name,
        version: fixtures.stimVersion,
        stim: fixtures.stimVersion,
        home: fixtures.home,
      },
      capabilities: ['read', 'control'],
      features: ['physical-ios', 'physical-android', 'notifications', 'workspace-diff', 'macos-window'],
      actions: ACTIONS,
      device: this.device,
    };
  }

  private every(ms: number, tick: (subscription: string) => void): string {
    const subscription = `s${this.nextSubscription++}`;
    this.timers.set(
      subscription,
      setInterval(() => tick(subscription), ms),
    );
    return subscription;
  }

  private stop(subscription: string): void {
    const timer = this.timers.get(subscription);
    if (timer !== undefined) clearInterval(timer);
    this.timers.delete(subscription);
    for (const feed of this.machine.feeds) {
      if (feed.connection === this && feed.subscription === subscription) this.machine.feeds.delete(feed);
    }
  }

  private call(method: string, params: Params, id: unknown): Outcome {
    const machine = this.machine;
    switch (method) {
      case 'status.subscribe': {
        const event = (subscription: string): unknown => {
          const payload = machine.status();
          return {
            event: 'status',
            subscription,
            payload,
            usage: usageHistory(payload.machine?.owners ?? [], Date.now()),
          };
        };
        const subscription = this.every(STATUS_MS, (sub) => this.send(event(sub)));
        setTimeout(() => this.timers.has(subscription) && this.send(event(subscription)), 0);
        return { result: { subscription } };
      }
      case 'logs.query':
        return { result: { records: filterRecords(machine.logs, params) } };
      case 'logs.subscribe': {
        let cursor = 0;
        const subscription = this.every(LOGS_MS, (sub) => {
          const record = { ...machine.logs[cursor++ % machine.logs.length], ts: Date.now() };
          const records = filterRecords([record], { ...params, tail: undefined });
          if (records.length > 0) this.send({ event: 'logs', subscription: sub, records });
        });
        setTimeout(
          () =>
            this.timers.has(subscription) &&
            this.send({ event: 'logs', subscription, records: filterRecords(machine.logs, params) }),
          0,
        );
        return { result: { subscription } };
      }
      case 'frames.subscribe': {
        const target = deviceTarget(params);
        if (!machine.fixtures.frames[target.key]) {
          return { error: ['no-frames', `The demo server has no ${String(params.platform)} screen.`] };
        }
        const subscription = this.every(FRAME_MS, () => this.sendFrame(feed));
        const feed: FrameFeed = { connection: this, subscription, ...target };
        machine.feeds.add(feed);
        setTimeout(() => this.timers.has(subscription) && this.sendFrame(feed), 0);
        return { result: { subscription } };
      }
      case 'unsubscribe':
        this.stop(String(params.subscription));
        return { result: {} };
      case 'control.begin':
        return this.beginControl(params);
      case 'control.end':
        this.sessions.delete(String(params.session));
        return { result: {} };
      case 'input.touch':
      case 'input.text':
      case 'input.button':
      case 'input.rotate':
      case 'input.posture':
      case 'input.simulator':
      case 'input.scroll':
      case 'input.key':
      case 'input.window':
        return this.input(method, params);
      case 'workspace.files':
        return { result: { files: changedFiles(params.group), truncated: false } };
      case 'workspace.diff':
        return { result: { path: params.path, patches: diffPatches(params.path) } };
      case 'stats.get':
        return { error: ['not-implemented', 'The demo server does not serve stats.'] };
      case 'build.plan': {
        const plan = machine.fixtures.plans[String(params.platform)];
        if (!plan) return { error: ['stim-failed', `The demo server has no ${String(params.platform)} build plan.`] };
        return {
          result: { ...plan, ...(params.slot && params.slot !== 'default' ? { slot: params.slot } : {}) },
        };
      }
      case 'settings.get':
        return {
          result: {
            project: null,
            files: {},
            settings: [{ key: 'recording.enabled', value: machine.recordingEnabled, origin: 'machine', layers: {} }],
            unknown: [],
          },
        };
      case 'replay.range':
        return { result: { enabled: machine.recordingEnabled, recording: false, spans: [], markers: [] } };
      case 'frames.seek':
      case 'frames.live':
        return {
          error: ['unknown-subscription', `No video subscription ${String(params.subscription)}.`],
        };
      case 'frames.keyframe':
        return { result: {} };
      case 'recording.set':
        machine.recordingEnabled = params.enabled === true;
        return { result: { enabled: machine.recordingEnabled, recordingsDeleted: [] } };
      case 'action':
        return this.action(params, id);
      case 'machine.get':
        return { result: usage(machine.fixtures.status.capacity.totalMemoryMb) };
      case 'machine.details':
        return { result: shiftTimestamps(machine.fixtures.machineDetails, machine.shiftMs) };
      case 'machine.history':
        return { result: history(typeof params.sinceMs === 'number' ? params.sinceMs : -Infinity) };
      case 'notifications.list': {
        const since = typeof params.since === 'number' ? params.since : 0;
        return {
          result: {
            log: NOTIFICATION_LOG,
            cursor: machine.notifications[0]?.seq,
            notifications: machine.notifications.filter((entry) => (entry.seq as number) > since),
          },
        };
      }
      default:
        return { error: ['unknown-method', `Unknown method ${method}.`] };
    }
  }

  private beginControl(params: Params): Outcome {
    const platform = String(params.platform);
    if (!CONTROL_PLATFORMS.includes(platform)) {
      return { error: ['bad-request', 'params.platform must be ios, android, web or macos.'] };
    }
    if (!this.machine.fixtures.status.environments.some((env) => env.path === params.workspace)) {
      return { error: ['bad-request', 'params.workspace must be an environment path from a status payload.'] };
    }
    if (params.physical === true) {
      return { error: ['action-failed', 'The demo server shows physical devices but cannot control them.'] };
    }
    const session = `c${this.nextSession++}`;
    const { target, key } = deviceTarget(params);
    this.sessions.set(session, { target, key, platform });
    return {
      result: {
        session,
        platform,
        lease: null,
        postures: [],
        ...(platform === 'ios' ? { simulator: SIMULATOR } : {}),
      },
    };
  }

  private input(method: string, params: Params): Outcome {
    if (typeof params.session !== 'string') {
      return { error: ['bad-request', `${method} needs params.session from control.begin.`] };
    }
    const session = this.sessions.get(params.session);
    if (!session) {
      return { error: ['unknown-session', `No control session ${params.session} on this connection.`] };
    }
    switch (method) {
      case 'input.touch': {
        const { phase, x, y } = params;
        if (typeof phase !== 'string' || !TOUCH_PHASES.includes(phase) || !fraction(x) || !fraction(y)) {
          return { error: ['bad-request', 'input.touch needs phase (down, move or up), and x and y from 0 to 1.'] };
        }
        if (phase === 'down') session.down = { x, y };
        if (phase === 'up' && session.down && Math.hypot(x - session.down.x, y - session.down.y) < TAP_SLOP) {
          this.machine.tap(session.target, session.key);
        }
        return { result: {} };
      }
      case 'input.simulator':
        if (session.platform !== 'ios') {
          return { error: ['bad-request', 'This session has no simulator development controls.'] };
        }
        return { result: SIMULATOR };
      case 'input.posture':
        return { error: ['bad-request', 'This device does not fold.'] };
      default:
        return { result: {} };
    }
  }

  private action(params: Params, id: unknown): Outcome {
    const machine = this.machine;
    const workspace = String(params.workspace);
    if (!ACTIONS.includes(String(params.action))) {
      return { error: ['unknown-action', `Unknown action ${String(params.action)}.`] };
    }
    const platformOk =
      params.platform === undefined ||
      (params.action === 'reload' && ['ios', 'android', 'web'].includes(String(params.platform)));
    if (!platformOk) return { error: ['bad-request', 'platform must be ios, android or web, and only for reload.'] };
    const env = machine.fixtures.status.environments.find((candidate) => candidate.path === workspace);
    if (!env) return { error: ['unknown-workspace', `${workspace} is not a Stim workspace on this Mac.`] };
    if (params.action === 'reload' && params.platform === undefined && runsBothPlatforms(env)) {
      return {
        error: [
          'action-failed',
          'STIM_RELOAD_AMBIGUOUS: Both the iOS and Android apps are running. Choose one with `stim reload ios` or `stim reload android`.',
        ],
      };
    }
    if (machine.busy.has(workspace)) {
      return { error: ['action-busy', `An action is already running in ${workspace}.`] };
    }
    machine.busy.add(workspace);
    setTimeout(() => {
      machine.busy.delete(workspace);
      this.send({ id, result: { action: params.action, workspace, output: { demo: true } } });
    }, ACTION_MS);
    return { deferred: true };
  }
}

function deviceTarget(params: Params): { target: string; key: string; platform: string; slot: string } {
  const platform = String(params.platform);
  const slot = typeof params.slot === 'string' ? params.slot : 'default';
  const workspace = String(params.workspace);
  return {
    target: `${workspace}\n${platform}\n${slot}`,
    key: `${workspace.includes('/notes-app/') ? 'notes-' : ''}${platform}`,
    platform,
    slot,
  };
}

function fraction(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function runsBothPlatforms(env: Environment): boolean {
  const slots = [env, ...(env.slots ?? [])];
  return slots.some((slot) => slot.ios?.state === 'Booted') && slots.some((slot) => slot.android?.state === 'detected');
}

function usage(totalMemoryMb: number): unknown {
  return {
    volumes: [
      {
        mount: '/',
        holds: ['Workspaces', 'Stim home', 'Simulators'],
        freeBytes: FREE_GB * GB,
        totalBytes: 994.66 * GB,
      },
    ],
    memory: { totalBytes: totalMemoryMb * 1024 * 1024, usedBytes: 31.4 * 2 ** 30, pressure: 'normal' },
    load: { avg1: 6.2, avg5: 5.4, avg15: 4.9, cpus: 14 },
    cpu: { usage: 0.34, cores: 14 },
    sampledAt: new Date().toISOString(),
  };
}

function history(sinceMs: number): unknown {
  const end = Math.floor(Date.now() / HISTORY_INTERVAL_MS) * HISTORY_INTERVAL_MS;
  const samples = [];
  for (let at = end - 719 * HISTORY_INTERVAL_MS; at <= end; at += HISTORY_INTERVAL_MS) {
    if (at <= sinceMs) continue;
    const phase = at / 600_000;
    samples.push({
      at,
      cpu: 0.3 + 0.25 * Math.sin(phase * 2 * Math.PI) ** 2,
      memoryUsedBytes: (29 + 3 * Math.sin(phase)) * 2 ** 30,
      memoryPressure: 0,
      diskFreeBytes: FREE_GB * GB,
    });
  }
  return { intervalMs: HISTORY_INTERVAL_MS, samples };
}

function notificationSamples(name: string): ({ ago: number } & Record<string, unknown>)[] {
  const search = `${ROOT}/habitat-app/.worktrees/search-screen`;
  const sdk = `${ROOT}/habitat-app/.worktrees/update-expo-sdk`;
  const layout = `${ROOT}/habitat-app/.worktrees/tablet-layout`;
  const sorting = `${ROOT}/notes-app/.worktrees/note-sorting`;
  const onboarding = `${ROOT}/notes-app/.worktrees/onboarding`;
  return [
    {
      ago: 2,
      id: `stuck:${search}`,
      category: 'stuck',
      title: 'search-screen',
      body: 'No agent activity for 15 min; iPhone 17 Pro 27.1 still up',
      quiet: true,
      target: { kind: 'device', path: search, platform: 'ios', slot: 'default' },
    },
    {
      ago: 18,
      id: `started:${layout}`,
      category: 'started',
      title: 'tablet-layout',
      body: `agent-device started driving iPhone 17 Pro 27.1 on ${name}`,
      quiet: true,
      target: { kind: 'device', path: layout, platform: 'ios', slot: 'default' },
    },
    {
      ago: 30,
      id: `build-failed:${sdk}`,
      category: 'attention',
      title: 'update-expo-sdk',
      body: 'iOS build failed: no provisioning profile found',
      quiet: true,
      target: { kind: 'build', path: sdk, platform: 'ios' },
    },
    {
      ago: 47,
      id: `looping-android:${search}`,
      category: 'looping',
      title: 'search-screen',
      body: 'Same Kotlin error 3x at SearchModule.kt:42',
      quiet: true,
      target: { kind: 'build', path: search, platform: 'android' },
    },
    {
      ago: 95,
      id: `finished:${sorting}`,
      category: 'finished',
      title: 'note-sorting',
      body: 'PR #214 is ready for review',
      quiet: true,
      target: { kind: 'url', path: sorting, url: 'https://github.com/example/notes-app/pull/214' },
    },
    {
      ago: 60 * 26,
      id: `control:${layout}:ios:default`,
      category: 'control',
      title: 'tablet-layout',
      body: 'iPad took over the iOS device you were controlling',
      quiet: true,
      target: { kind: 'device', path: layout, platform: 'ios', slot: 'default' },
    },
    {
      ago: 60 * 30,
      id: `finished:${layout}`,
      category: 'finished',
      title: 'tablet-layout',
      body: 'Agent stopped after a green iOS build',
      quiet: true,
      target: { kind: 'workspace', path: layout },
      suppressed: 'muted',
    },
    {
      ago: 60 * 50,
      id: `started:${onboarding}`,
      category: 'started',
      title: 'onboarding',
      body: `Warming on ${name}`,
      quiet: true,
      target: { kind: 'workspace', path: onboarding },
    },
  ];
}

function changedFiles(group: unknown): unknown[] {
  if (group === 'untracked') {
    return [{ path: 'src/lib/search-history.ts', status: '??', staged: false, unstaged: false, untracked: true }];
  }
  return [
    { path: 'src/screens/search.tsx', status: 'MM', staged: true, unstaged: true, untracked: false },
    { path: 'src/components/result-row.tsx', status: ' M', staged: false, unstaged: true, untracked: false },
    { path: 'src/lib/habits.ts', status: 'M ', staged: true, unstaged: false, untracked: false },
  ];
}

const header = (file: string): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;

function diffPatches(path: unknown): unknown[] {
  if (path === 'src/lib/search-history.ts') {
    return [
      {
        section: 'untracked',
        kind: 'text',
        text: 'export const MAX_RECENT = 5;\n\nexport function addRecent(list: string[], query: string): string[] {\n  const next = [query, ...list.filter((item) => item !== query)];\n  return next.slice(0, MAX_RECENT);\n}\n',
      },
    ];
  }
  if (path === 'src/components/result-row.tsx') {
    return [
      {
        section: 'unstaged',
        kind: 'text',
        text:
          header('src/components/result-row.tsx') +
          '@@ -8,7 +8,7 @@ export function ResultRow({ habit }: Props) {\n' +
          '   return (\n' +
          '     <Row>\n' +
          '-      <Title>{habit.name}</Title>\n' +
          '+      <Title numberOfLines={1}>{habit.name}</Title>\n' +
          '       <Subtitle>{habit.schedule}</Subtitle>\n',
      },
    ];
  }
  if (path === 'src/lib/habits.ts') {
    return [
      {
        section: 'staged',
        kind: 'text',
        text:
          header('src/lib/habits.ts') +
          '@@ -3,3 +3,7 @@ export type Habit = {\n' +
          '   name: string;\n' +
          '+  archived: boolean;\n' +
          ' };\n' +
          '+\n' +
          '+export const isActive = (habit: Habit) => !habit.archived;\n',
      },
    ];
  }
  return [
    {
      section: 'staged',
      kind: 'text',
      text:
        header('src/screens/search.tsx') +
        '@@ -12,6 +12,10 @@ export function SearchScreen() {\n' +
        "   const [query, setQuery] = useState('');\n" +
        "+  const [filter, setFilter] = useState<Filter>('all');\n" +
        '+  const results = useSearch(query, filter);\n' +
        '   return (\n' +
        '     <Screen title="Search">\n',
    },
    {
      section: 'unstaged',
      kind: 'text',
      text:
        header('src/screens/search.tsx') +
        '@@ -20,5 +24,9 @@ export function SearchScreen() {\n' +
        '       <SearchField value={query} onChangeText={setQuery} />\n' +
        '-      <ResultList data={results.map(toRow)} />\n' +
        '+      <FilterChips value={filter} onChange={setFilter} />\n' +
        '+      <ResultList data={(results ?? []).map(toRow)} />\n' +
        '+      {results?.length === 0 ? <EmptyState query={query} /> : null}\n' +
        '     </Screen>\n' +
        '@@ -41,3 +49,12 @@ function toRow(habit: Habit) {\n' +
        '   return { id: habit.id, title: habit.name };\n' +
        ' }\n' +
        '+\n' +
        '+function EmptyState({ query }: { query: string }) {\n' +
        '+  return (\n' +
        '+    <View style={styles.empty}>\n' +
        '+      <Text style={styles.emptyTitle}>No habits match "{query}"</Text>\n' +
        '+      <Text style={styles.emptyBody}>Try a different word or clear the filter.</Text>\n' +
        '+    </View>\n' +
        '+  );\n' +
        '+}\n',
    },
  ];
}

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
