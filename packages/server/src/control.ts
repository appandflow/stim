import { spawn } from 'node:child_process';
import {
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity } from '@stim-cli/core/process-identity';
import { takeHostedInputClaim } from './hosted-input.ts';
import { isJsonObject, type DeviceActivity, type StatusPayload } from '@stim-cli/core/state';
import { actionOutcome, type AuditRecord } from './actions.ts';
import type { FeedPool, FeedSpec } from './feed.ts';
import { adbPath } from './frame-helper.ts';
import {
  deviceKey,
  devicePostures,
  ownedDevice,
  workspaceLease,
  type Device,
  type DeviceInput,
  type FramePool,
} from './frames.ts';
import {
  INPUT_BUTTONS,
  PLATFORMS,
  MAX_INPUT_TEXT,
  ROTATE_DIRECTIONS,
  TOUCH_PHASES,
  type ControlBeginParams,
  type ControlBeginResult,
  type ControlEndedEvent,
  type DevicePosture,
  type ErrorCode,
  type InputButton,
  type Platform,
  type ProtocolError,
  type RotateDirection,
  type ServerMessage,
  type TouchPhase,
} from './protocol.ts';
import { oversightTitle } from '@stim-cli/core/oversight';
import type { ControlConflict } from './push.ts';
import type { PairedDevice } from './registry.ts';
import { Pending, runStim, terminate, type CommandLimits } from './stim-command.ts';

type Refusal = { code: ErrorCode; message: string };
type Parsed<T> = { value: T } | Refusal;

export const SLOT_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT = /^[\x20-\x7e\n\t\b]+$/;

export function parseControlBegin(params: unknown): Parsed<ControlBeginParams> {
  if (!isJsonObject(params)) return { code: 'bad-request', message: 'params must be an object.' };
  const { workspace, platform, slot, physical, takeOver, ...rest } = params;
  if (Object.keys(rest).length) {
    return { code: 'bad-request', message: `control.begin does not take ${Object.keys(rest).join(', ')}.` };
  }
  if (typeof workspace !== 'string') {
    return { code: 'bad-request', message: 'params.workspace must be an environment path from a status payload.' };
  }
  if (!PLATFORMS.includes(platform as Platform)) {
    return { code: 'bad-request', message: 'params.platform must be ios, android or web.' };
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return { code: 'bad-request', message: 'params.slot must be 1-64 letters, digits, underscores or hyphens.' };
  }
  if (takeOver !== undefined && typeof takeOver !== 'boolean') {
    return { code: 'bad-request', message: 'params.takeOver must be true or false.' };
  }
  if (physical !== undefined && typeof physical !== 'boolean') {
    return { code: 'bad-request', message: 'params.physical must be true or false.' };
  }
  if (physical && platform === 'ios') {
    return {
      code: 'action-failed',
      message: 'A physical iPhone is view only: Stim shows its screen but sends it no input.',
    };
  }
  return {
    value: {
      workspace,
      platform: platform as Platform,
      ...(slot ? { slot } : {}),
      ...(physical ? { physical } : {}),
      ...(takeOver ? { takeOver } : {}),
    },
  };
}

export type InputCommand =
  | { input: 'touch'; phase: TouchPhase; x: number; y: number; display?: number }
  | { input: 'text'; text: string }
  | { input: 'button'; button: InputButton }
  | { input: 'rotate'; direction: RotateDirection }
  | { input: 'posture'; posture: DevicePosture };

type InputMethod = 'input.touch' | 'input.text' | 'input.button' | 'input.rotate' | 'input.posture';

/**
 * What a control session accepts: its device's platform, the postures `input.posture` takes, and whether it is a
 * physical device, which turns only in hand.
 */
export interface SessionTarget {
  platform: Platform;
  postures: readonly DevicePosture[];
  physical?: boolean;
}

const IOS_BUTTONS: readonly InputButton[] = ['home', 'lock'];
const WEB_BUTTONS: readonly InputButton[] = ['back'];

function fraction(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** Validates an `input.*` request for one of the connection's sessions; returns its session id and command. */
export function parseInput(
  method: InputMethod,
  params: unknown,
  targetOf: (session: string) => SessionTarget | null,
): Parsed<{ session: string; command: InputCommand }> {
  if (!isJsonObject(params) || typeof params.session !== 'string') {
    return { code: 'bad-request', message: `${method} needs params.session from control.begin.` };
  }
  const target = targetOf(params.session);
  if (!target) return { code: 'unknown-session', message: `No control session ${params.session} on this connection.` };
  const { platform, postures } = target;
  const session = params.session;
  if (platform === 'web' && (method === 'input.rotate' || method === 'input.posture')) {
    return { code: 'bad-request', message: 'A web page does not rotate or fold.' };
  }
  if (target.physical && (method === 'input.rotate' || method === 'input.posture')) {
    return { code: 'bad-request', message: 'A physical device rotates and folds only in hand.' };
  }
  if (method === 'input.rotate') {
    const { direction } = params;
    if (!ROTATE_DIRECTIONS.includes(direction as RotateDirection)) {
      return { code: 'bad-request', message: 'input.rotate needs direction left or right.' };
    }
    return { value: { session, command: { input: 'rotate', direction: direction as RotateDirection } } };
  }
  if (method === 'input.posture') {
    const { posture } = params;
    if (!postures.includes(posture as DevicePosture)) {
      const accepted = postures.length ? `takes these postures: ${postures.join(', ')}` : 'has no hinge';
      return { code: 'bad-request', message: `This device ${accepted}.` };
    }
    return { value: { session, command: { input: 'posture', posture: posture as DevicePosture } } };
  }
  if (method === 'input.touch') {
    const { phase, x, y, display } = params;
    if (!TOUCH_PHASES.includes(phase as TouchPhase) || !fraction(x) || !fraction(y)) {
      return { code: 'bad-request', message: 'input.touch needs phase (down, move or up), and x and y from 0 to 1.' };
    }
    if (display !== undefined && (!Number.isInteger(display) || (display as number) < 0 || (display as number) > 3)) {
      return { code: 'bad-request', message: 'display must be a display index from 0 to 3.' };
    }
    if (platform !== 'ios' && display !== undefined && display !== 0) {
      return { code: 'bad-request', message: 'An emulator or a web page takes input on its main display (0) only.' };
    }
    return {
      value: {
        session,
        command: {
          input: 'touch',
          phase: phase as TouchPhase,
          x: x as number,
          y: y as number,
          ...(display === undefined ? {} : { display: display as number }),
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
  const allowed = platform === 'ios' ? IOS_BUTTONS : platform === 'web' ? WEB_BUTTONS : INPUT_BUTTONS;
  if (!allowed.includes(button as InputButton)) {
    const device = { ios: 'An iOS device', android: 'An Android device', web: 'A web page' }[platform];
    return { code: 'bad-request', message: `${device} takes these buttons: ${allowed.join(', ')}.` };
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

const ADB_TIMEOUT_MS = 10_000;

const POSTURE_TIMEOUT_MS = 5_000;

function runQuietly(
  env: NodeJS.ProcessEnv,
  file: string,
  args: string[],
  label: string,
  timeoutMs: number,
  claim?: ClaimHandle,
): Promise<void> {
  let childPid: number | undefined;
  return new Promise<void>((resolve, reject) => {
    if (claim) markClaimChildPending(claim);
    const child = spawn(file, args, { env, detached: !!claim, stdio: ['ignore', 'ignore', 'pipe'] });
    childPid = child.pid;
    let stderr = '';
    let timedOut = false;
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (claim && child.pid && processGroupAlive(child.pid))
        return reject(new Error(`${label} left an unresolved process group; its input claim was retained.`));
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (code ${code}): ${stderr.trim()}`));
    };
    const timer = setTimeout(() => {
      child.stderr.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return finish(child.exitCode);
      timedOut = true;
      void terminate(child).then(() => {
        return reject(new Error(`${label} did not finish within ${timeoutMs / 1000} s.`));
      });
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-500)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start (${error.message}).`));
    });
    child.on('close', finish);
    if (claim) {
      try {
        const identity = child.pid ? captureProcessIdentity(child.pid) : null;
        if (!identity?.ok) throw new Error(`${label} child identity could not be established.`);
        setClaimChild(claim, { pid: child.pid!, processToken: identity.token });
      } catch (error) {
        timedOut = true;
        clearTimeout(timer);
        void terminate(child).then(() => reject(error));
      }
    }
  }).finally(() => {
    if (claim && (!childPid || !processGroupAlive(childPid))) releaseClaim(claim);
  });
}

function runAdb(env: NodeJS.ProcessEnv, serial: string, args: string[]): Promise<void> {
  return runQuietly(env, adbPath(env), ['-s', serial, ...args], `adb ${args.slice(0, 3).join(' ')}`, ADB_TIMEOUT_MS);
}

function activityOf(payload: StatusPayload, target: ControlBeginParams): DeviceActivity | undefined {
  if (target.physical) return undefined;
  const environment = payload.environments?.find((candidate) => candidate.path === target.workspace);
  const slot = target.slot ?? 'default';
  const devices = slot === 'default' ? environment : environment?.slots?.find((candidate) => candidate.slot === slot);
  if (target.platform === 'web') return slot === 'default' ? environment?.web?.activity : undefined;
  return target.platform === 'ios' ? devices?.ios?.activity : devices?.android?.activity;
}

const DEVICE_NOUN = { ios: 'iOS device', android: 'Android device', web: 'web page' } as const;

function conflictAbout(payload: StatusPayload, target: ControlBeginParams): Omit<ControlConflict, 'body'> {
  const environment = payload.environments?.find((candidate) => candidate.path === target.workspace);
  return {
    workspace: target.workspace,
    title: environment ? oversightTitle(environment, payload) : target.workspace,
    platform: target.platform,
    slot: target.slot ?? 'default',
  };
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

function heldLease(
  status: StatusPayload,
  target: ControlBeginParams,
  options: { adbEmulators: boolean },
): Lease | Refusal {
  const lease = workspaceLease(status, target, options);
  if (!lease?.expiresAt) {
    return { code: 'forbidden', message: `${target.workspace} does not hold the lease on this device.` };
  }
  return { grantedAt: lease.grantedAt, expiresAt: lease.expiresAt, mine: false };
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
  frames: FramePool;
  permitted?: () => boolean;
  claim?: ClaimHandle;
  postures: DevicePosture[];
  startedAt: number;
  idle: NodeJS.Timeout;
  renew: NodeJS.Timeout;
  unwatch: () => void;
  renewing: Promise<void>;
  adb: Promise<void>;
  ended: boolean;
  /** The driver this session took over, and whether another one was already pushed to the owner. */
  driver: string | null;
  driverNoticed: boolean;
}

/** One authenticated connection that can hold control sessions. */
export interface Controller {
  device: Pick<PairedDevice, 'id' | 'name'>;
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
  /** Resolves to the `sim-fold` helper, building it on first use. */
  foldHelper: () => Promise<string>;
  foldTimeoutMs: number;
  /** Tells the paired device `deviceId` that someone else took over, or started driving, the device it controls. */
  conflict: (deviceId: string, conflict: ControlConflict) => void;
  /** Test switch: resolves a `physical` target to an emulator the workspace leases, driven over adb. */
  adbEmulators?: boolean;
}

const STATUS_WAIT_MS = 60_000;

/**
 * Control sessions across all connections: at most one per device. A session holds the device's `stim-frames`
 * helper for input. Ordinary sessions hold a `stim device lock` lease, renewed while they last and released
 * when they end if they took it. Hosted sessions use their native session's ownership claim instead.
 */
export class ControlHub {
  private readonly options: ControlOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly byDevice = new Map<string, Session>();
  private readonly ownLeases = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly folding = new Map<string, Promise<void>>();
  private readonly pending = new Pending();
  private closing = false;
  private next = 1;

  constructor(options: ControlOptions) {
    this.options = options;
  }

  /** `grantedAt` of the leases this hub took for phones, so their control does not count as an agent. */
  ownLeaseTimes(): string[] {
    return [...this.ownLeases];
  }

  targetOf(owner: Controller, session: string): SessionTarget | null {
    const found = this.sessions.get(session);
    return found && found.owner === owner && !found.ended
      ? {
          platform: found.target.platform,
          postures: found.postures,
          ...(found.target.physical ? { physical: true } : {}),
        }
      : null;
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
    const resolve = { adbEmulators: this.options.adbEmulators === true };
    const device = ownedDevice(status, target, null, resolve);
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
    let lease: Lease | Refusal | null;
    let postures: DevicePosture[];
    try {
      [lease, postures] = await this.pending.track(
        Promise.all([
          target.physical
            ? Promise.resolve(heldLease(status, target, resolve))
            : this.lock(device, target, cwd, beganAt),
          devicePostures(device, this.options.env, POSTURE_TIMEOUT_MS),
        ]),
      );
    } finally {
      this.starting.delete(key);
    }
    const granted = lease === null || 'code' in lease ? null : lease;
    if (lease !== null && !granted && (!target.takeOver || target.physical)) return lease as Refusal;
    const current = this.byDevice.get(key);
    const refuse = (refusal: Refusal): Refusal => {
      if (granted?.mine && !current?.lease?.mine) void this.pending.track(this.unlock(target, cwd));
      return refusal;
    };
    if (this.closing || !stillAllowed()) {
      return refuse({ code: 'forbidden', message: 'This device can no longer control devices.' });
    }
    if (current && current !== earlier && !target.takeOver) {
      return refuse({ code: 'device-busy', message: `${current.owner.device.name} started controlling this device.` });
    }
    return this.open(owner, target, cwd, device, postures, granted, driver, current, beganAt, status);
  }

  async beginHosted(
    owner: Controller,
    target: ControlBeginParams,
    cwd: string,
    device: Device,
    frames: FramePool,
    stillAllowed: () => boolean,
    claim: ClaimHandle,
  ): Promise<ControlBeginResult | Refusal> {
    if (this.closing) return { code: 'action-failed', message: 'stim-server is stopping.' };
    const key = deviceKey(device);
    if (this.starting.has(key))
      return { code: 'device-busy', message: 'Another client is starting to control this device. Try again.' };
    const earlier = this.byDevice.get(key);
    if (earlier && !target.takeOver)
      return { code: 'device-busy', message: `${earlier.owner.device.name} is controlling this device.` };
    this.starting.add(key);
    let postures: DevicePosture[];
    try {
      postures = await this.pending.track(devicePostures(device, this.options.env, POSTURE_TIMEOUT_MS));
    } finally {
      this.starting.delete(key);
    }
    if (this.closing || !stillAllowed())
      return { code: 'forbidden', message: 'This hosted session can no longer be controlled.' };
    const current = this.byDevice.get(key);
    if (current && current !== earlier && !target.takeOver)
      return { code: 'device-busy', message: `${current.owner.device.name} started controlling this device.` };
    return this.open(
      owner,
      target,
      cwd,
      device,
      postures,
      null,
      current?.owner.device.name ?? null,
      current,
      Date.now(),
      undefined,
      frames,
      stillAllowed,
      claim,
    );
  }

  private open(
    owner: Controller,
    target: ControlBeginParams,
    cwd: string,
    device: Device,
    postures: DevicePosture[],
    granted: Lease | null,
    driver: string | null,
    current: Session | undefined,
    beganAt: number,
    status?: StatusPayload,
    frames: FramePool = this.options.frames,
    permitted?: () => boolean,
    claim?: ClaimHandle,
  ): ControlBeginResult | Refusal {
    const key = deviceKey(device);
    const resolve = { adbEmulators: this.options.adbEmulators === true };
    let session: Session;
    const input = frames.control(device, (message) => queueMicrotask(() => void this.end(session, 'failed', message)));
    if (!input) {
      if (granted?.mine && !current?.lease?.mine) void this.pending.track(this.unlock(target, cwd));
      return { code: 'action-failed', message: 'Input needs the stim-frames helper, which this Mac has not built.' };
    }
    const inherited = granted !== null && current?.lease?.mine === true;
    if (current) {
      void this.end(current, 'taken-over', `${owner.device.name} took over this device.`, !inherited);
      if (status && current.owner.device.id !== owner.device.id)
        this.options.conflict(current.owner.device.id, {
          ...conflictAbout(status, target),
          body: `${owner.device.name} took over the ${DEVICE_NOUN[target.platform]} you were controlling`,
        });
    }
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
      frames,
      ...(permitted ? { permitted } : {}),
      ...(claim ? { claim } : {}),
      postures,
      startedAt: Date.now(),
      idle: setTimeout(() => void this.end(session, 'idle', 'No input for 5 minutes.'), this.options.idleMs),
      renew: setInterval(() => this.renew(session, beganAt), this.options.renewMs),
      renewing: Promise.resolve(),
      unwatch: () => {},
      adb: Promise.resolve(),
      ended: false,
      driver,
      driverNoticed: false,
    };
    this.sessions.set(id, session);
    this.byDevice.set(key, session);
    if (status)
      session.unwatch = this.options.feeds.subscribe(this.options.statusFeed, {
        item: (payload) => {
          const latest = payload as unknown as StatusPayload;
          const resolved = ownedDevice(latest, target, key, resolve);
          if (target.physical && session.lease && typeof resolved !== 'string') {
            session.lease.expiresAt = workspaceLease(latest, target, resolve)?.expiresAt ?? session.lease.expiresAt;
          }
          if (typeof resolved === 'string' || deviceKey(resolved) !== key) {
            const message = typeof resolved === 'string' ? resolved : 'The device changed.';
            queueMicrotask(() => void this.end(session, 'device-gone', message));
            return;
          }
          const other = otherDriver(activityOf(latest, target), this.ownLeases);
          if (other && other !== session.driver && !session.driverNoticed && !session.ended) {
            session.driverNoticed = true;
            const tool = activityOf(latest, target)?.driver?.tool ?? 'An agent';
            this.options.conflict(owner.device.id, {
              ...conflictAbout(latest, target),
              body: `${tool} started driving the ${DEVICE_NOUN[target.platform]} you are controlling`,
            });
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
      postures,
    };
  }

  private renew(session: Session, beganAt: number): void {
    if (session.ended || !session.lease?.mine) return;
    session.renewing = this.pending.track(
      (async () => {
        const renewed = await this.lock(session.device, session.target, session.cwd, beganAt);
        if (renewed === null) return;
        if ('code' in renewed) console.error(`stim-server: could not renew the device lease: ${renewed.message}`);
        else if (session.lease) session.lease.expiresAt = renewed.expiresAt;
      })(),
    );
  }

  input(owner: Controller, id: string, command: InputCommand): Promise<Refusal | null> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.ended) {
      return Promise.resolve({ code: 'unknown-session', message: `No control session ${id} on this connection.` });
    }
    if (session.permitted && !session.permitted()) {
      void this.end(session, 'device-gone', 'The hosted session is no longer available.');
      return Promise.resolve({ code: 'forbidden', message: 'The hosted session is no longer available.' });
    }
    session.idle.refresh();
    if (session.target.physical && session.lease && Date.parse(session.lease.expiresAt) <= Date.now()) {
      const message = "The workspace's lease on this device expired.";
      void this.end(session, 'device-gone', message);
      return Promise.resolve({ code: 'unknown-session', message });
    }
    if (command.input === 'posture' && session.device.platform === 'ios') {
      const udid = session.device.udid;
      if (this.folding.has(udid))
        return Promise.resolve({ code: 'device-busy', message: 'The device is still folding.' });
      const folded = this.fold(session, udid, command.posture);
      const settled = folded.then(() => {
        this.folding.delete(udid);
        return undefined;
      });
      this.folding.set(udid, settled);
      session.adb = settled;
      return folded;
    }
    if (
      session.device.platform !== 'android' ||
      session.device.physical ||
      command.input === 'touch' ||
      command.input === 'rotate' ||
      command.input === 'posture' ||
      session.input.keys()
    ) {
      session.input.send(
        command.input === 'touch' && command.display === undefined
          ? { ...command, display: session.frames.litDisplay(session.device) }
          : command,
      );
      return Promise.resolve(null);
    }
    const serial = session.device.serial;
    const previous = session.adb;
    const run = (async (): Promise<Refusal | null> => {
      await previous;
      try {
        for (const args of adbInputArgs(command as Extract<InputCommand, { input: 'text' | 'button' }>)) {
          if (session.ended) return null;
          await runAdb(this.options.env, serial, args);
        }
        return null;
      } catch (cause) {
        return { code: 'action-failed', message: (cause as Error).message };
      }
    })();
    session.adb = run.then(() => undefined);
    return this.pending.track(run);
  }

  /**
   * `sim-fold` sweeps the hinge to the other posture, so it runs only when the Duo's last frame shows the
   * other one.
   */
  private async fold(session: Session, udid: string, posture: DevicePosture): Promise<Refusal | null> {
    const current = session.frames.litPosture(session.device);
    if (!current) {
      return { code: 'action-failed', message: 'Subscribe to frames of this device to learn its posture first.' };
    }
    if (current === posture) return null;
    try {
      const helper = await this.options.foldHelper();
      if (session.ended) return null;
      await this.pending.track(
        runQuietly(
          this.options.env,
          'xcrun',
          ['simctl', 'spawn', udid, helper],
          'sim-fold',
          this.options.foldTimeoutMs,
          session.claim ? takeHostedInputClaim(session.claim) : undefined,
        ),
      );
      session.frames.folded(udid, posture === 'folded' ? 'folded' : 'unfolded');
      return null;
    } catch (cause) {
      return { code: 'action-failed', message: (cause as Error).message };
    }
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

  async endDevice(device: Device, message: string): Promise<void> {
    const session = this.byDevice.get(deviceKey(device));
    if (session) {
      await this.end(session, 'device-gone', message);
      await session.adb;
    }
    if (device.platform === 'ios') await this.folding.get(device.udid);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const session of this.sessions.values()) void this.end(session, null, 'stim-server stopped.');
    await this.pending.settled();
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
    return this.pending.track(session.renewing.then(() => this.unlock(session.target, session.cwd)));
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
  ): Promise<Lease | Refusal | null> {
    if (device.platform === 'web') return null;
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
