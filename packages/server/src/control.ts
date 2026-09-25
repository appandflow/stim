import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isJsonObject, type DeviceActivity, type StatusPayload } from '@stim-cli/core/state';
import { actionOutcome, type AuditRecord } from './actions.ts';
import type { FeedPool, FeedSpec } from './feed.ts';
import { deviceKey, ownedDevice, type Device, type DeviceInput, type FramePool } from './frames.ts';
import {
  INPUT_BUTTONS,
  MAX_INPUT_TEXT,
  TOUCH_PHASES,
  type ControlBeginParams,
  type ControlBeginResult,
  type ControlEndedEvent,
  type ErrorCode,
  type InputButton,
  type Platform,
  type ProtocolError,
  type ServerMessage,
  type TouchPhase,
} from './protocol.ts';
import type { PairedDevice } from './registry.ts';
import { runStim, terminate, type CommandLimits } from './stim-command.ts';

type Refusal = { code: ErrorCode; message: string };
type Parsed<T> = { value: T } | Refusal;

export const SLOT_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT = /^[\x20-\x7e\n\t\b]+$/;

export function parseControlBegin(params: unknown): Parsed<ControlBeginParams> {
  if (!isJsonObject(params)) return { code: 'bad-request', message: 'params must be an object.' };
  const { workspace, platform, slot, takeOver, ...rest } = params;
  if (Object.keys(rest).length) {
    return { code: 'bad-request', message: `control.begin does not take ${Object.keys(rest).join(', ')}.` };
  }
  if (typeof workspace !== 'string') {
    return { code: 'bad-request', message: 'params.workspace must be an environment path from a status payload.' };
  }
  if (platform !== 'ios' && platform !== 'android') {
    return { code: 'bad-request', message: 'params.platform must be ios or android.' };
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return { code: 'bad-request', message: 'params.slot must be 1-64 letters, digits, underscores or hyphens.' };
  }
  if (takeOver !== undefined && typeof takeOver !== 'boolean') {
    return { code: 'bad-request', message: 'params.takeOver must be true or false.' };
  }
  return { value: { workspace, platform, ...(slot ? { slot } : {}), ...(takeOver ? { takeOver } : {}) } };
}

export type InputCommand =
  | { input: 'touch'; phase: TouchPhase; x: number; y: number; display: number }
  | { input: 'text'; text: string }
  | { input: 'button'; button: InputButton };

const IOS_BUTTONS: readonly InputButton[] = ['home', 'lock'];

function fraction(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** Validates an `input.*` request for a session on `platform`; returns its session id and command. */
export function parseInput(
  method: 'input.touch' | 'input.text' | 'input.button',
  params: unknown,
  platformOf: (session: string) => Platform | null,
): Parsed<{ session: string; command: InputCommand }> {
  if (!isJsonObject(params) || typeof params.session !== 'string') {
    return { code: 'bad-request', message: `${method} needs params.session from control.begin.` };
  }
  const platform = platformOf(params.session);
  if (!platform)
    return { code: 'unknown-session', message: `No control session ${params.session} on this connection.` };
  const session = params.session;
  if (method === 'input.touch') {
    const { phase, x, y, display = 0 } = params;
    if (!TOUCH_PHASES.includes(phase as TouchPhase) || !fraction(x) || !fraction(y)) {
      return { code: 'bad-request', message: 'input.touch needs phase (down, move or up), and x and y from 0 to 1.' };
    }
    if (!Number.isInteger(display) || (display as number) < 0 || (display as number) > 3) {
      return { code: 'bad-request', message: 'display must be a display index from 0 to 3.' };
    }
    if (platform === 'android' && display !== 0) {
      return { code: 'bad-request', message: 'An emulator takes input on its main display (0) only.' };
    }
    return {
      value: {
        session,
        command: {
          input: 'touch',
          phase: phase as TouchPhase,
          x: x as number,
          y: y as number,
          display: display as number,
        },
      },
    };
  }
  if (method === 'input.text') {
    const { text } = params;
    if (typeof text !== 'string' || !text.length || text.length > MAX_INPUT_TEXT || !TEXT.test(text)) {
      return {
        code: 'bad-request',
        message: `input.text takes 1 to ${MAX_INPUT_TEXT} printable ASCII characters, with \\n, \\t and \\b.`,
      };
    }
    return { value: { session, command: { input: 'text', text } } };
  }
  const { button } = params;
  const allowed = platform === 'ios' ? IOS_BUTTONS : INPUT_BUTTONS;
  if (!allowed.includes(button as InputButton)) {
    return { code: 'bad-request', message: `An ${platform} device takes these buttons: ${allowed.join(', ')}.` };
  }
  return { value: { session, command: { input: 'button', button: button as InputButton } } };
}

const ANDROID_KEYS: Record<InputButton | '\n' | '\t' | '\b', string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  'app-switch': 'KEYCODE_APP_SWITCH',
  lock: 'KEYCODE_POWER',
  '\n': 'KEYCODE_ENTER',
  '\t': 'KEYCODE_TAB',
  '\b': 'KEYCODE_DEL',
};

/**
 * The `adb shell` argument lists that type `text` or press `button` on an emulator without a hardware keyboard
 * (`hw.keyboard=no`), which drops gRPC key events. `adb shell` joins its arguments into one device shell
 * command, so text goes single-quoted; `input text` reads `%s` as a space.
 */
function adbInputArgs(command: Extract<InputCommand, { input: 'text' | 'button' }>): string[][] {
  if (command.input === 'button') return [['shell', 'input', 'keyevent', ANDROID_KEYS[command.button]]];
  const calls: string[][] = [];
  for (const part of command.text.split(/([\n\t\b]+)/)) {
    if (!part) continue;
    if (/^[\n\t\b]+$/.test(part)) {
      calls.push(['shell', 'input', 'keyevent', ...Array.from(part, (key) => ANDROID_KEYS[key as '\n' | '\t' | '\b'])]);
      continue;
    }
    calls.push(['shell', 'input', 'text', `'${part.replaceAll(' ', '%s').replaceAll("'", "'\\''")}'`]);
  }
  return calls;
}

function adbPath(env: NodeJS.ProcessEnv): string {
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(env.HOME ?? homedir(), 'Library/Android/sdk')]) {
    if (sdk && existsSync(join(sdk, 'platform-tools/adb'))) return join(sdk, 'platform-tools/adb');
  }
  return 'adb';
}

const ADB_TIMEOUT_MS = 10_000;

function runAdb(env: NodeJS.ProcessEnv, serial: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath(env), ['-s', serial, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => void terminate(child), ADB_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-500)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`adb could not start (${error.message}).`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`adb ${args.slice(0, 3).join(' ')} failed (code ${code}): ${stderr.trim()}`));
    });
  });
}

function activityOf(payload: StatusPayload, target: ControlBeginParams): DeviceActivity | undefined {
  const environment = payload.environments?.find((candidate) => candidate.path === target.workspace);
  const slot = target.slot ?? 'default';
  const devices = slot === 'default' ? environment : environment?.slots?.find((candidate) => candidate.slot === slot);
  return target.platform === 'ios' ? devices?.ios?.activity : devices?.android?.activity;
}

function otherDriver(activity: DeviceActivity | undefined, ownLeases: ReadonlySet<string>): string | null {
  if (activity?.state !== 'driven' || !activity.driver) return null;
  const { tool, since } = activity.driver;
  if (tool === 'stim device lock' && since && ownLeases.has(since)) return null;
  return since ? `${tool} (since ${since})` : tool;
}

interface Lease {
  grantedAt: string | null;
  expiresAt: string;
  mine: boolean;
}

interface Session {
  id: string;
  owner: Controller;
  device: Device;
  key: string;
  target: ControlBeginParams;
  cwd: string;
  lease: Lease | null;
  input: DeviceInput;
  startedAt: number;
  idle: NodeJS.Timeout;
  renew: NodeJS.Timeout;
  unwatch: () => void;
  renewing: Promise<void>;
  adb: Promise<void>;
  ended: boolean;
}

/** One authenticated connection that can hold control sessions. */
export interface Controller {
  device: PairedDevice;
  send: (message: ServerMessage) => void;
}

export interface ControlOptions {
  env: NodeJS.ProcessEnv;
  stimCli: string;
  feeds: FeedPool;
  frames: FramePool;
  statusFeed: FeedSpec;
  audit: (record: AuditRecord) => void;
  lockLimits: CommandLimits;
  idleMs: number;
  renewMs: number;
  leaseFor: string;
}

const STATUS_WAIT_MS = 60_000;

/**
 * Control sessions across all connections: at most one per device. A session holds the device's `stim-frames`
 * helper for input and a `stim device lock` lease, renewed while it lasts and released when it ends if the
 * session took it.
 */
export class ControlHub {
  private readonly options: ControlOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly byDevice = new Map<string, Session>();
  private readonly ownLeases = new Set<string>();
  private readonly starting = new Set<string>();
  private closing = false;
  private next = 1;

  constructor(options: ControlOptions) {
    this.options = options;
  }

  platformOf(owner: Controller, session: string): Platform | null {
    const found = this.sessions.get(session);
    return found && found.owner === owner && !found.ended ? found.target.platform : null;
  }

  /**
   * `stillAllowed` is checked again after the status read and the lock, which can take seconds: the client may
   * have disconnected or lost `control` meanwhile.
   */
  async begin(
    owner: Controller,
    target: ControlBeginParams,
    cwd: string,
    stillAllowed: () => boolean,
  ): Promise<ControlBeginResult | Refusal> {
    const beganAt = Date.now();
    if (this.closing) return { code: 'action-failed', message: 'stim-server is stopping.' };
    const status = await this.status();
    if ('code' in status) return status;
    const device = ownedDevice(status, target, null);
    if (typeof device === 'string') return { code: 'action-failed', message: device };
    const key = deviceKey(device);
    if (this.starting.has(key)) {
      return { code: 'device-busy', message: 'Another client is starting to control this device. Try again.' };
    }
    const earlier = this.byDevice.get(key);
    const driver = earlier
      ? `${earlier.owner.device.name} through stim-server`
      : otherDriver(activityOf(status, target), this.ownLeases);
    if (driver && !target.takeOver) {
      return { code: 'device-busy', message: `This device is driven by ${driver}. Take over to control it anyway.` };
    }
    this.starting.add(key);
    let lease: Lease | Refusal;
    try {
      lease = await this.lock(device, target, cwd, beganAt);
    } finally {
      this.starting.delete(key);
    }
    const granted = 'code' in lease ? null : lease;
    if (!granted && !target.takeOver) return lease as Refusal;
    const current = this.byDevice.get(key);
    const refuse = (refusal: Refusal): Refusal => {
      if (granted?.mine && !current?.lease?.mine) void this.unlock(target, cwd);
      return refusal;
    };
    if (this.closing || !stillAllowed()) {
      return refuse({ code: 'forbidden', message: 'This device can no longer control devices.' });
    }
    if (current && current !== earlier && !target.takeOver) {
      return refuse({ code: 'device-busy', message: `${current.owner.device.name} started controlling this device.` });
    }
    let session: Session;
    const input = this.options.frames.control(device, (message) =>
      queueMicrotask(() => void this.end(session, 'failed', message)),
    );
    if (!input) {
      return refuse({
        code: 'action-failed',
        message: 'Input needs the stim-frames helper, which this Mac has not built.',
      });
    }
    const inherited = granted !== null && current?.lease?.mine === true;
    if (current) void this.end(current, 'taken-over', `${owner.device.name} took over this device.`, !inherited);
    const id = `c${this.next++}`;
    session = {
      id,
      owner,
      device,
      key,
      target,
      cwd,
      lease: granted ? { ...granted, mine: granted.mine || inherited } : null,
      input,
      startedAt: Date.now(),
      idle: setTimeout(() => void this.end(session, 'idle', 'No input for 5 minutes.'), this.options.idleMs),
      renew: setInterval(() => this.renew(session, beganAt), this.options.renewMs),
      renewing: Promise.resolve(),
      unwatch: () => {},
      adb: Promise.resolve(),
      ended: false,
    };
    this.sessions.set(id, session);
    this.byDevice.set(key, session);
    session.unwatch = this.options.feeds.subscribe(this.options.statusFeed, {
      item: (payload) => {
        const resolved = ownedDevice(payload as unknown as StatusPayload, target, key);
        if (typeof resolved === 'string' || deviceKey(resolved) !== key) {
          const message = typeof resolved === 'string' ? resolved : 'The device changed.';
          queueMicrotask(() => void this.end(session, 'device-gone', message));
        }
      },
      failed: () => {},
    });
    this.audit(owner, target, driver || current ? 'control.take-over' : 'control.begin', {
      ok: true,
      ...(driver || current ? { reason: `took over from ${driver ?? current!.owner.device.name}` } : {}),
    });
    return {
      session: id,
      platform: target.platform,
      lease: session.lease ? { grantedAt: session.lease.grantedAt, expiresAt: session.lease.expiresAt } : null,
    };
  }

  private renew(session: Session, beganAt: number): void {
    if (session.ended || !session.lease?.mine) return;
    session.renewing = (async () => {
      const renewed = await this.lock(session.device, session.target, session.cwd, beganAt);
      if ('code' in renewed) console.error(`stim-server: could not renew the device lease: ${renewed.message}`);
      else if (session.lease) session.lease.expiresAt = renewed.expiresAt;
    })();
  }

  input(owner: Controller, id: string, command: InputCommand): Promise<Refusal | null> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.ended) {
      return Promise.resolve({ code: 'unknown-session', message: `No control session ${id} on this connection.` });
    }
    session.idle.refresh();
    if (session.device.platform === 'ios' || command.input === 'touch' || session.input.keys()) {
      session.input.send(command);
      return Promise.resolve(null);
    }
    const serial = session.device.serial;
    const previous = session.adb;
    const run = (async (): Promise<Refusal | null> => {
      await previous;
      try {
        for (const args of adbInputArgs(command)) {
          if (session.ended) return null;
          await runAdb(this.options.env, serial, args);
        }
        return null;
      } catch (cause) {
        return { code: 'action-failed', message: (cause as Error).message };
      }
    })();
    session.adb = run.then(() => undefined);
    return run;
  }

  endById(owner: Controller, id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return false;
    void this.end(session, null, 'The client ended the session.');
    return true;
  }

  endFor(owner: Controller, reason: ControlEndedEvent['reason'] | null, message: string): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) void this.end(session, reason, message);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const releases = [...this.sessions.values()].map((session) => this.end(session, null, 'stim-server stopped.'));
    await Promise.all(releases);
  }

  private end(
    session: Session,
    reason: ControlEndedEvent['reason'] | null,
    message: string,
    release = true,
  ): Promise<void> {
    if (session.ended) return Promise.resolve();
    session.ended = true;
    clearTimeout(session.idle);
    clearInterval(session.renew);
    session.unwatch();
    session.input.detach();
    this.sessions.delete(session.id);
    if (this.byDevice.get(session.key) === session) this.byDevice.delete(session.key);
    if (reason) session.owner.send({ event: 'control-ended', session: session.id, reason, message });
    this.audit(session.owner, session.target, 'control.end', {
      ok: true,
      durationMs: Date.now() - session.startedAt,
      reason: `${reason ?? 'ended'}: ${message}`,
    });
    if (!release || !session.lease?.mine) return Promise.resolve();
    return session.renewing.then(() => this.unlock(session.target, session.cwd));
  }

  private status(): Promise<StatusPayload | Refusal> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (value: StatusPayload | Refusal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(value);
      };
      const timer = setTimeout(
        () => finish({ code: 'status-failed', message: 'stim status did not report the device in time.' }),
        STATUS_WAIT_MS,
      );
      unsubscribe = this.options.feeds.subscribe(this.options.statusFeed, {
        item: (payload) => finish(payload as unknown as StatusPayload),
        failed: (message) => finish({ code: 'status-failed', message }),
      });
      if (settled) unsubscribe();
    });
  }

  private async lock(
    device: Device,
    target: ControlBeginParams,
    cwd: string,
    beganAt: number,
  ): Promise<Lease | Refusal> {
    const id = device.platform === 'ios' ? device.udid : device.serial;
    const slot = target.slot && target.slot !== 'default' ? ['--slot', target.slot] : [];
    const args = [
      'device',
      'lock',
      target.platform,
      id,
      '--for',
      this.options.leaseFor,
      '--wait',
      '0',
      '--json',
      ...slot,
    ];
    const outcome = await runStim(this.options.stimCli, this.options.env, args, cwd, this.options.lockLimits).outcome;
    const printed = actionOutcome(outcome);
    if (!printed.ok) {
      const busy = printed.error.message.startsWith('STIM_DEVICE_BUSY');
      return { code: busy ? 'device-busy' : 'action-failed', message: `stim device lock: ${printed.error.message}` };
    }
    const grantedAt = typeof printed.output.grantedAt === 'string' ? printed.output.grantedAt : null;
    const expiresAt = typeof printed.output.expiresAt === 'string' ? printed.output.expiresAt : '';
    const mine = grantedAt !== null && Date.parse(grantedAt) >= beganAt - 1000;
    if (mine) this.ownLeases.add(grantedAt);
    return { grantedAt, expiresAt, mine };
  }

  private async unlock(target: ControlBeginParams, cwd: string): Promise<void> {
    const slot = target.slot && target.slot !== 'default' ? ['--slot', target.slot] : [];
    const outcome = await runStim(
      this.options.stimCli,
      this.options.env,
      ['device', 'unlock', target.platform, '--json', ...slot],
      cwd,
      this.options.lockLimits,
    ).outcome;
    if (!outcome.ok) console.error(`stim-server: could not release the device lease: ${outcome.message}`);
  }

  private audit(
    owner: Controller,
    target: ControlBeginParams,
    action: string,
    outcome: { ok: boolean; error?: ProtocolError; durationMs?: number; reason?: string },
  ): void {
    this.options.audit({
      at: new Date().toISOString(),
      device: { id: owner.device.id, name: owner.device.name },
      action,
      workspace: target.workspace,
      platform: target.platform,
      ...outcome,
    });
  }
}
