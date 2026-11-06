import { createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import type { NoiseDh, NoiseKeyPair } from '@stim-cli/core/noise';
import {
  acceptNoise,
  CLOSE_REFUSED,
  decodeSecret,
  HandshakeRefusal,
  keyFingerprint,
  MODE_FIRST_CONTACT,
  secretValues,
  type RawSocket,
  type SecretValues,
} from '@stim-cli/core/noise-session';
import { statusViews, withDerivedFacts } from '@stim-cli/core/phone-protocol';
import { MAX_CLIPBOARD_BYTES } from '@stim-cli/core/protocol';

import { shiftTimestamps } from '../../mobile/mock-server/payloads.mjs';
import { createFakeHandlers, type Outcome } from '../../mobile/mock-server/fake.mjs';

export interface Frame {
  mime: string;
  width: number;
  height: number;
  data: string;
}

type StatusPayload = Parameters<typeof statusViews>[0];

interface LogRecord {
  ts: number;
  workspace: string;
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
}

/** A paired phone, by the hex of its static key. */
export interface DeviceRecord {
  name: string;
  /** The `lookup` of the `DEMO_TOKEN` it paired with, so a new token unpairs it. */
  lookup: string;
}

export interface DemoAuth {
  /** The pairing token: it never expires and pairs any number of phones. Without a valid one, every phone is refused. */
  token: string | undefined;
  keyPair: NoiseKeyPair;
  devices: { get(key: string): DeviceRecord | undefined; set(key: string, record: DeviceRecord): void };
}

type Params = Record<string, unknown>;
type Timer = ReturnType<typeof setInterval>;

const PROTOCOL = 2;
const FRAME_MS = 1000;
const MINUTE = 60_000;
const CONTROL_PLATFORMS = ['ios', 'android', 'web', 'macos'];
const TOUCH_PHASES = ['down', 'move', 'up'];
const TAP_SLOP = 0.03;
const MAX_DEVICE_NAME = 64;
const SIMULATOR = { canShake: false, slowAnimations: null };
const ROOT = '/Users/demo/Developer';
const SUBSCRIPTION_LIMITS = new Map([
  ['workspaces.subscribe', 2],
  ['machine.subscribe', 2],
  ['workspace.subscribe', 8],
  ['logs.subscribe', 8],
  ['frames.subscribe', 16],
]);
export const HANDSHAKE_MS = 10_000;
const HELLO_MS = 10_000;
const utf8 = new TextDecoder();

// workerd's node:crypto diffieHellman fails for every X25519 public key it imports, as DER or JWK.
export const workerDh: NoiseDh = (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey);

interface FrameFeed {
  connection: DemoConnection;
  subscription: string;
  target: string;
  key: string;
  platform: string;
  slot: string;
}

export function upgradeFromWebPage(headers: Pick<Headers, 'get'>, url: string): boolean {
  if (headers.get('sec-fetch-site') !== null) return true;
  const origin = headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).host !== new URL(url).host;
  } catch {
    return true;
  }
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
  private readonly auth: DemoAuth;
  private readonly secret: SecretValues | null;

  constructor(fixtures: Fixtures, name: string, auth: DemoAuth) {
    this.fixtures = fixtures;
    this.name = name;
    this.auth = auth;
    const token = auth.token === undefined ? null : decodeSecret(auth.token);
    this.secret = token && secretValues(token);
    this.shiftMs = this.startedAt - Date.parse(fixtures.capturedAt);
    this.logs = fixtures.logs.map((record) => Object.assign({}, record, { ts: record.ts + this.shiftMs }));
    this.notifications = notificationSamples(name)
      .toReversed()
      .map(({ ago, ...rest }, i) =>
        Object.assign({ seq: i + 1, at: new Date(this.startedAt - ago * MINUTE).toISOString() }, rest),
      )
      .toReversed();
  }

  connect(peer: Peer, device: Device): DemoConnection {
    return new DemoConnection(this, peer, device);
  }

  /** The pairing code for the review notes, without its `pairingToken`. */
  pairingCode(endpoint: string): { v: number; name: string; endpoint: string; fingerprint: string } {
    return { v: PROTOCOL, name: this.name, endpoint, fingerprint: keyFingerprint(this.auth.keyPair.publicKey) };
  }

  /**
   * Runs the protocol 2 handshake on a socket's first message, as stim-server does, except that the pairing token is
   * never spent. It resolves with the phone's connection, or null after closing a refused socket.
   */
  async accept(raw: RawSocket, first: unknown, isBinary: boolean): Promise<DemoConnection | null> {
    const lookup = this.secret && hex(this.secret.lookup);
    let accepted;
    try {
      accepted = await acceptNoise(raw, first, isBinary, {
        keyPair: this.auth.keyPair,
        psk: (candidate) => (this.secret && candidate === lookup ? this.secret.psk : null),
        timeoutMs: HANDSHAKE_MS,
        dh: workerDh,
      });
    } catch (error) {
      if (error instanceof HandshakeRefusal) return null;
      throw error;
    }
    const key = hex(accepted.clientKey);
    let record = this.auth.devices.get(key);
    if (accepted.mode === MODE_FIRST_CONTACT && lookup !== null) {
      record = { name: deviceName(accepted.payload), lookup };
      this.auth.devices.set(key, record);
    } else if (!record || record.lookup !== lookup) {
      raw.close(CLOSE_REFUSED, 'unauthorized');
      return null;
    }
    const device = { id: createHash('sha256').update(accepted.clientKey).digest('hex').slice(0, 8), name: record.name };
    const { socket } = accepted;
    const connection = this.connect(
      { send: (text) => socket.send(text), close: () => socket.close(1008, 'no hello') },
      device,
    );
    socket.on('message', (data: Uint8Array, binary: boolean) => {
      if (!binary) void connection.receive(utf8.decode(data));
    });
    socket.on('close', () => connection.close());
    return connection;
  }

  status(): StatusPayload {
    const payload = shiftTimestamps(this.fixtures.status, this.shiftMs) as StatusPayload;
    payload.environments = payload.environments.map((env) =>
      withDerivedFacts({ ...env, recording: { enabled: this.recordingEnabled } }),
    );
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
}

export class DemoConnection {
  private nextSubscription = 1;
  private nextSession = 1;
  private readonly timers = new Map<string, Timer>();
  private readonly kinds = new Map<string, string>();
  private greeted = false;
  private readonly helloTimer: Timer;
  private readonly sessions = new Map<
    string,
    { target: string; key: string; platform: string; clipboard: string; down?: { x: number; y: number } }
  >();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly machine: DemoMachine;
  private readonly peer: Peer;
  private readonly handlers: ReturnType<typeof createFakeHandlers>;

  constructor(machine: DemoMachine, peer: Peer, device: Device) {
    this.machine = machine;
    this.peer = peer;
    this.handlers = createFakeHandlers(
      {
        kind: 'demo',
        fixtures: machine.fixtures,
        statusViews,
        status: () => machine.status(),
        shiftMs: machine.shiftMs,
        logsFor: (params: Params) => machine.logs.filter((record) => record.workspace === params.workspace),
        notifications: machine.notifications,
        notificationLog: 'demo',
        readOnly: false,
        get recordingEnabled() {
          return machine.recordingEnabled;
        },
        set recordingEnabled(enabled: boolean) {
          machine.recordingEnabled = enabled;
        },
        busy: machine.busy,
        freeGb: () => 212,
        historyFreeGb: 212,
        changedFiles,
        diffPatches,
        hello: {
          server: {
            name: machine.name,
            version: machine.fixtures.stimVersion,
            stim: machine.fixtures.stimVersion,
            home: machine.fixtures.home,
          },
          hostCapabilities: ['physical-ios', 'physical-android', 'macos-window'],
          features: ['physical-ios', 'physical-android', 'notifications', 'workspace-diff', 'macos-window'],
          device,
        },
      },
      {
        send: (message: unknown) => this.send(message),
        every: (method: string, ms: number, tick: (subscription: string) => void) => this.every(method, ms, tick),
        later: (fn: () => void) => setTimeout(fn, 0),
        active: (subscription: string) => this.timers.has(subscription),
        stop: (subscription: string) => this.stop(subscription),
      },
    );
    this.helloTimer = setTimeout(() => {
      if (this.closed) return;
      this.close();
      this.peer.close();
    }, HELLO_MS);
  }

  receive(text: string): Promise<void> {
    this.queue = this.queue.then(() => this.handle(text)).catch(() => {});
    return this.queue;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.helloTimer);
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

  private handle(text: string): void {
    if (this.closed) return;
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
    if (method !== 'hello' && !this.greeted) return fail('unauthorized', 'Send hello first.');
    let outcome: Outcome;
    try {
      outcome = method === 'hello' ? this.hello() : this.call(method, params, id);
    } catch (error) {
      return fail('bad-request', (error as Error).message);
    }
    if ('error' in outcome) return fail(...outcome.error);
    if ('result' in outcome) this.send({ id, result: outcome.result });
  }

  private hello(): Outcome {
    this.greeted = true;
    clearTimeout(this.helloTimer);
    return this.handlers.hello();
  }

  private every(method: string, ms: number, tick: (subscription: string) => void): string {
    const subscription = `s${this.nextSubscription++}`;
    this.kinds.set(subscription, method);
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
    this.kinds.delete(subscription);
    for (const feed of this.machine.feeds) {
      if (feed.connection === this && feed.subscription === subscription) this.machine.feeds.delete(feed);
    }
  }

  private call(method: string, params: Params, id: unknown): Outcome {
    const machine = this.machine;
    const limit = SUBSCRIPTION_LIMITS.get(method);
    if (limit !== undefined && [...this.kinds.values()].filter((kind) => kind === method).length >= limit) {
      return { error: ['limit-exceeded', `A connection can hold ${limit} ${method} subscriptions.`] };
    }
    const handler = Object.hasOwn(this.handlers, method) ? this.handlers[method] : undefined;
    if (handler) return handler(params, id);
    switch (method) {
      case 'frames.subscribe': {
        const target = deviceTarget(params);
        if (!machine.fixtures.frames[target.key]) {
          return { error: ['no-frames', `The demo server has no ${String(params.platform)} screen.`] };
        }
        const subscription = this.every(method, FRAME_MS, () => this.sendFrame(feed));
        const feed: FrameFeed = { connection: this, subscription, ...target };
        machine.feeds.add(feed);
        setTimeout(() => this.timers.has(subscription) && this.sendFrame(feed), 0);
        return { result: { subscription } };
      }
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
      case 'input.clipboard.set':
      case 'input.clipboard.get':
        return this.input(method, params);
      case 'replay.range':
        return { result: { enabled: machine.recordingEnabled, recording: false, spans: [], markers: [] } };
      case 'archive.detail':
        return { error: ['unknown-workspace', `Archive ${String(params.archive)} is not a Stim archive on this Mac.`] };
      case 'frames.seek':
      case 'frames.live':
        return {
          error: ['unknown-subscription', `No video subscription ${String(params.subscription)}.`],
        };
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
    this.sessions.set(session, { target, key, platform, clipboard: '' });
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
      case 'input.clipboard.set':
      case 'input.clipboard.get':
        return clipboard(method, params, session);
      default:
        return { result: {} };
    }
  }
}

function clipboard(
  method: 'input.clipboard.set' | 'input.clipboard.get',
  params: Params,
  session: { platform: string; clipboard: string },
): Outcome {
  if (session.platform === 'web' || session.platform === 'macos') {
    return {
      error: [
        'bad-request',
        'Only an iOS simulator, an Android emulator and an Android phone have a clipboard to set or read.',
      ],
    };
  }
  const { text, paste } = params;
  if (method === 'input.clipboard.get') {
    if (text !== undefined || paste !== undefined) {
      return { error: ['bad-request', 'input.clipboard.get takes only session.'] };
    }
    return { result: { text: session.clipboard } };
  }
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES ||
    (paste !== undefined && typeof paste !== 'boolean')
  ) {
    return {
      error: [
        'bad-request',
        `input.clipboard.set takes text of at most ${MAX_CLIPBOARD_BYTES} UTF-8 bytes and an optional paste flag.`,
      ],
    };
  }
  session.clipboard = text;
  return { result: {} };
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

function deviceName(payload: Uint8Array): string {
  try {
    const { name } = JSON.parse(utf8.decode(payload)) as { name?: unknown };
    if (typeof name === 'string' && name !== '') return name.slice(0, MAX_DEVICE_NAME);
  } catch {}
  return 'Phone';
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
