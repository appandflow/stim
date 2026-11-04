import { spawn } from 'node:child_process';
import { createStim } from 'stim';
import {
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity } from '@stim-cli/core/process-identity';
import { takeHostedInputClaim } from './hosted-input.ts';
import { GRAB_IDLE_MS, PointerGrab } from './pointer-grab.ts';
import { presenceKey, type PresenceHub } from './presence.ts';
import { isJsonObject, type DeviceActivity, type StatusPayload } from '@stim-cli/core/state';
import { actionOutcome, type AuditRecord } from './actions.ts';
import type { FeedListener } from './feed.ts';
import { adbPath, simulatorOptions } from './frame-helper.ts';
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
  INPUT_KEYS,
  KEY_MODIFIERS,
  type InputKey,
  type KeyModifier,
  PLATFORMS,
  MAX_INPUT_TEXT,
  MAX_CLIPBOARD_BYTES,
  MAX_CLIPBOARD_READ_BYTES,
  ROTATE_DIRECTIONS,
  TOUCH_PHASES,
  type ControlBeginParams,
  type ControlPlatform,
  type ControlBeginResult,
  type ControlEndedEvent,
  type DevicePosture,
  type ErrorCode,
  type InputButton,
  type InputClipboardGetResult,
  type InputClipboardSetResult,
  type SimulatorCommand,
  type SimulatorOptions,
  type Platform,
  type PresenceParticipant,
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
type TouchCommand = Extract<InputCommand, { input: 'touch' }>;
/** A touch dropped because another participant holds the pointer; `busy` is that participant's name. */
export type BusyRefusal = Refusal & { busy: string };
type Parsed<T> = { value: T } | Refusal;

export const SLOT_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT = /^[\x20-\x7e\n\t\b]+$/;

const PASTE_TYPEABLE = /^[\x20-\x7e\n\t]+$/;

export function pasteTypingChunks(text: string): string[] | null {
  const typed = text.replaceAll('\r\n', '\n');
  if (!PASTE_TYPEABLE.test(typed)) return null;
  const chunks: string[] = [];
  for (let at = 0; at < typed.length; at += MAX_INPUT_TEXT) chunks.push(typed.slice(at, at + MAX_INPUT_TEXT));
  return chunks;
}

export const PASTE_TYPING_CHARS_PER_SECOND = 32;

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
    return { code: 'bad-request', message: 'params.platform must be ios, android, web or macos.' };
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
      platform: platform as ControlPlatform,
      ...(slot ? { slot } : {}),
      ...(physical ? { physical } : {}),
      ...(takeOver ? { takeOver } : {}),
    },
  };
}

export type InputCommand =
  | {
      input: 'touch';
      phase: TouchPhase;
      x: number;
      y: number;
      x2?: number;
      y2?: number;
      display?: number;
      duoRevision?: string;
    }
  | { input: 'text'; text: string }
  | { input: 'clipboard'; text: string; paste: boolean }
  | { input: 'clipboard-get' }
  | { input: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { input: 'key'; key: InputKey; modifiers: KeyModifier[] }
  | { input: 'window'; window: number | null }
  | { input: 'button'; button: InputButton }
  | { input: 'rotate'; direction: RotateDirection }
  | { input: 'posture'; posture: DevicePosture }
  | ({ input: 'simulator' } & SimulatorCommand);

type InputMethod =
  | 'input.touch'
  | 'input.text'
  | 'input.button'
  | 'input.rotate'
  | 'input.posture'
  | 'input.simulator'
  | 'input.scroll'
  | 'input.key'
  | 'input.window'
  | 'input.clipboard.set'
  | 'input.clipboard.get';

/**
 * What a control session accepts: its device's platform, the postures `input.posture` takes, and whether it is a
 * physical device, which turns only in hand.
 */
export interface SessionTarget {
  slot?: string;
  platform: ControlPlatform;
  postures: readonly DevicePosture[];
  simulator?: SimulatorOptions;
  physical?: boolean;
}

/** The keys an iOS or Android device takes as `input.key`: the arrows and Escape. */
const DEVICE_KEYS = ['left', 'right', 'up', 'down', 'escape'] as const;
type DeviceKey = (typeof DEVICE_KEYS)[number];

function isDeviceKey(key: unknown): key is DeviceKey {
  return DEVICE_KEYS.some((candidate) => candidate === key);
}

const IOS_BUTTONS: readonly InputButton[] = ['home', 'lock'];
const WEB_BUTTONS: readonly InputButton[] = ['back'];

function delta(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000;
}

function fraction(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function parseDeviceKey(
  session: string,
  platform: 'ios' | 'android',
  params: Record<string, unknown>,
): Parsed<{ session: string; command: InputCommand }> {
  const { key, modifiers = [] } = params;
  if (!isDeviceKey(key) || !Array.isArray(modifiers) || modifiers.length) {
    return {
      code: 'bad-request',
      message: `An ${platform === 'ios' ? 'iOS' : 'Android'} device takes the keys ${DEVICE_KEYS.join(', ')}, without modifiers.`,
    };
  }
  return { value: { session, command: { input: 'key', key, modifiers: [] } } };
}

function parseScrollOrKey(
  method: 'input.scroll' | 'input.key',
  session: string,
  platform: ControlPlatform,
  params: Record<string, unknown>,
): Parsed<{ session: string; command: InputCommand }> {
  if (platform !== 'macos' && method === 'input.key' && platform !== 'web') {
    return parseDeviceKey(session, platform, params);
  }
  if (platform !== 'macos')
    return { code: 'bad-request', message: 'This input is for a native macOS app window only.' };
  if (method === 'input.scroll') {
    const { x, y, deltaX, deltaY } = params;
    if (!fraction(x) || !fraction(y) || !delta(deltaX) || !delta(deltaY)) {
      return {
        code: 'bad-request',
        message: 'input.scroll needs x and y from 0 to 1 and finite pixel deltas from -1000 to 1000.',
      };
    }
    return {
      value: {
        session,
        command: {
          input: 'scroll',
          x: x as number,
          y: y as number,
          deltaX: deltaX as number,
          deltaY: deltaY as number,
        },
      },
    };
  }
  const { key, modifiers = [] } = params;
  if (
    !INPUT_KEYS.includes(key as InputKey) ||
    !Array.isArray(modifiers) ||
    modifiers.length > 4 ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.every((modifier) => KEY_MODIFIERS.includes(modifier as KeyModifier))
  ) {
    return {
      code: 'bad-request',
      message: 'input.key needs a supported native key and unique command, shift, option or control modifiers.',
    };
  }
  return {
    value: { session, command: { input: 'key', key: key as InputKey, modifiers: modifiers as KeyModifier[] } },
  };
}

function parseClipboard(
  method: 'input.clipboard.set' | 'input.clipboard.get',
  session: string,
  platform: ControlPlatform,
  physical: boolean,
  params: Record<string, unknown>,
): Parsed<{ session: string; command: InputCommand }> {
  if (platform === 'web' || platform === 'macos' || (platform === 'ios' && physical)) {
    return {
      code: 'bad-request',
      message: 'Only an iOS simulator, an Android emulator and an Android phone have a clipboard to set or read.',
    };
  }
  const { text, paste } = params;
  if (method === 'input.clipboard.get') {
    if (text !== undefined || paste !== undefined) {
      return { code: 'bad-request', message: 'input.clipboard.get takes only session.' };
    }
    return { value: { session, command: { input: 'clipboard-get' } } };
  }
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES ||
    (paste !== undefined && typeof paste !== 'boolean')
  ) {
    return {
      code: 'bad-request',
      message: `input.clipboard.set takes text of at most ${MAX_CLIPBOARD_BYTES} UTF-8 bytes and an optional paste flag.`,
    };
  }
  return { value: { session, command: { input: 'clipboard', text, paste: paste === true } } };
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
  if (
    platform === 'macos' &&
    !['input.touch', 'input.text', 'input.scroll', 'input.key', 'input.window'].includes(method)
  ) {
    return {
      code: 'bad-request',
      message: 'A native macOS app takes mouse, scroll, text, keyboard and window input only.',
    };
  }
  if (method === 'input.window') {
    if (platform !== 'macos')
      return { code: 'bad-request', message: 'This input is for a native macOS app window only.' };
    const window = params.window;
    if (
      window !== null &&
      (typeof window !== 'number' || !Number.isInteger(window) || window < 0 || window > 0xffffffff)
    )
      return { code: 'bad-request', message: 'input.window needs a window id from 0 to 4294967295 or null.' };
    return { value: { session, command: { input: 'window', window } } };
  }
  if (method === 'input.scroll' || method === 'input.key') return parseScrollOrKey(method, session, platform, params);
  if (method === 'input.clipboard.set' || method === 'input.clipboard.get') {
    return parseClipboard(method, session, platform, target.physical === true, params);
  }
  if (platform === 'web' && (method === 'input.rotate' || method === 'input.posture')) {
    return { code: 'bad-request', message: 'A web page does not rotate or fold.' };
  }
  if (target.physical && (method === 'input.rotate' || method === 'input.posture')) {
    return { code: 'bad-request', message: 'A physical device rotates and folds only in hand.' };
  }
  if (method === 'input.simulator') {
    const available = target.simulator;
    if (platform !== 'ios' || target.physical || !available) {
      return { code: 'bad-request', message: 'This session has no simulator development controls.' };
    }
    const { action, enabled, ...rest } = params;
    if (Object.keys(rest).some((key) => key !== 'session')) {
      return { code: 'bad-request', message: 'Unexpected simulator option parameter.' };
    }
    if (action === 'slow-animations' && typeof enabled === 'boolean' && available.slowAnimations !== null) {
      return { value: { session, command: { input: 'simulator', action, enabled } } };
    }
    if (enabled === undefined && (action === 'read' || (action === 'shake' && available.canShake))) {
      return { value: { session, command: { input: 'simulator', action } } };
    }
    return { code: 'bad-request', message: 'The session does not support that simulator option.' };
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
    const { phase, x, y, x2, y2, display, duoRevision } = params;
    if (!TOUCH_PHASES.includes(phase as TouchPhase) || !fraction(x) || !fraction(y)) {
      return { code: 'bad-request', message: 'input.touch needs phase (down, move or up), and x and y from 0 to 1.' };
    }
    let second: { x2: number; y2: number } | null = null;
    if (x2 !== undefined || y2 !== undefined) {
      if (typeof x2 !== 'number' || typeof y2 !== 'number' || !fraction(x2) || !fraction(y2)) {
        return { code: 'bad-request', message: 'input.touch takes x2 and y2 together, each from 0 to 1.' };
      }
      if (platform === 'web' || platform === 'macos' || (platform === 'ios' && postures.length > 0)) {
        return { code: 'bad-request', message: 'This device takes one finger only.' };
      }
      second = { x2, y2 };
    }
    if (
      display !== undefined &&
      (typeof display !== 'number' || !Number.isInteger(display) || display < 0 || display > 3)
    ) {
      return { code: 'bad-request', message: 'display must be a display index from 0 to 3.' };
    }
    if (platform !== 'ios' && display !== undefined && display !== 0) {
      return { code: 'bad-request', message: 'An emulator or a web page takes input on its main display (0) only.' };
    }
    if (
      duoRevision !== undefined &&
      (platform !== 'ios' ||
        target.physical ||
        postures.length === 0 ||
        display !== undefined ||
        typeof duoRevision !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(duoRevision))
    ) {
      return {
        code: 'bad-request',
        message: 'duoRevision needs a composed Duo image revision, without a display index.',
      };
    }
    return {
      value: {
        session,
        command: {
          input: 'touch',
          phase: phase as TouchPhase,
          x: x as number,
          y: y as number,
          ...second,
          ...(display === undefined ? {} : { display }),
          ...(duoRevision === undefined ? {} : { duoRevision: duoRevision as string }),
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
    const device = {
      ios: 'An iOS device',
      android: 'An Android device',
      web: 'A web page',
      macos: 'A native macOS app',
    }[platform];
    return { code: 'bad-request', message: `${device} takes these buttons: ${allowed.join(', ')}.` };
  }
  return { value: { session, command: { input: 'button', button: button as InputButton } } };
}

const ANDROID_KEYS: Record<InputButton | DeviceKey | '\n' | '\t' | '\b', string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  'app-switch': 'KEYCODE_APP_SWITCH',
  lock: 'KEYCODE_POWER',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  escape: 'KEYCODE_ESCAPE',
  '\n': 'KEYCODE_ENTER',
  '\t': 'KEYCODE_TAB',
  '\b': 'KEYCODE_DEL',
};

/**
 * The `adb shell` argument lists that type `text` or press `button` on an emulator without a hardware keyboard
 * (`hw.keyboard=no`), which drops gRPC key events. `adb shell` joins its arguments into one device shell
 * command, so text goes single-quoted; `input text` reads `%s` as a space.
 */
export function adbInputArgs(command: Extract<InputCommand, { input: 'text' | 'button' | 'key' }>): string[][] {
  if (command.input === 'button') return [['shell', 'input', 'keyevent', ANDROID_KEYS[command.button]]];
  if (command.input === 'key') {
    return isDeviceKey(command.key) ? [['shell', 'input', 'keyevent', ANDROID_KEYS[command.key]]] : [];
  }
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

const CLIPBOARD_TIMEOUT_MS = 10_000;

export const CLIPBOARD_INPUT_COST = 10;

/** `simctl pbcopy` reads its stdin as bytes in the process's locale, so a non-ASCII clipboard needs UTF-8. */
function simctlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, LC_ALL: 'en_US.UTF-8' };
}

interface ChildText {
  input?: string;
  maxOutput?: number;
}

function runQuietly(
  env: NodeJS.ProcessEnv,
  file: string,
  args: string[],
  label: string,
  timeoutMs: number,
  claim?: ClaimHandle,
  text: ChildText = {},
): Promise<string> {
  let childPid: number | undefined;
  return new Promise<string>((resolve, reject) => {
    if (claim) markClaimChildPending(claim);
    const child = spawn(file, args, { env, detached: !!claim, stdio: ['pipe', 'pipe', 'pipe'] });
    childPid = child.pid;
    let stderr = '';
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    let timedOut = false;
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (claim && child.pid && processGroupAlive(child.pid))
        return reject(new Error(`${label} left an unresolved process group; its input claim was retained.`));
      if (oversized) return reject(new Error(`${label} wrote more than ${text.maxOutput} bytes.`));
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`${label} failed (code ${code}): ${stderr.trim()}`));
    };
    child.stdin.on('error', () => {});
    child.stdin.end(text.input);
    const limit = text.maxOutput;
    child.stdout.on('data', (chunk: Buffer) => {
      if (limit === undefined) return;
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        child.kill();
      } else chunks.push(chunk);
    });
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
    if (claim && child.pid !== undefined) {
      try {
        const identity = captureProcessIdentity(child.pid);
        if (!identity.ok) throw new Error(`${label} child identity could not be established.`);
        setClaimChild(claim, { pid: child.pid, processToken: identity.token });
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
  return runQuietly(
    env,
    adbPath(env),
    ['-s', serial, ...args],
    `adb ${args.slice(0, 3).join(' ')}`,
    ADB_TIMEOUT_MS,
  ).then(() => undefined);
}

function activityOf(payload: StatusPayload, target: ControlBeginParams): DeviceActivity | undefined {
  if (target.physical || target.platform === 'macos') return undefined;
  const environment = payload.environments?.find((candidate) => candidate.path === target.workspace);
  const slot = target.slot ?? 'default';
  const devices = slot === 'default' ? environment : environment?.slots?.find((candidate) => candidate.slot === slot);
  if (target.platform === 'web') return slot === 'default' ? environment?.web?.activity : undefined;
  return target.platform === 'ios' ? devices?.ios?.activity : devices?.android?.activity;
}

const DEVICE_NOUN = {
  ios: 'iOS device',
  android: 'Android device',
  web: 'web page',
  macos: 'native macOS app',
} as const;

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
  simulator: SimulatorOptions | null;
  simulatorAbort: AbortController;
  grab: PointerGrab<PresenceParticipant, TouchCommand>;
  grabIdle: NodeJS.Timeout | null;
  /** Whether the session's own controller, not a participant it forwards, published a touch as the host. */
  hostShown: boolean;
  startedAt: number;
  idle: NodeJS.Timeout;
  renew: NodeJS.Timeout;
  unwatch: () => void;
  renewing: Promise<void>;
  adb: Promise<void>;
  pasteTimer: NodeJS.Timeout | null;
  pasteTypingUntil: number;
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
  frames: FramePool;
  subscribeStatus: (listener: FeedListener) => () => void;
  audit: (record: AuditRecord) => void;
  lockLimits: CommandLimits;
  idleMs: number;
  renewMs: number;
  leaseFor: string;
  /** Resolves to the `sim-fold` helper, building it on first use. */
  foldHelper: () => Promise<string>;
  foldTimeoutMs: number;
  frameHelper: () => string | null;
  /** Tells the paired device `deviceId` that someone else took over, or started driving, the device it controls. */
  conflict: (deviceId: string, conflict: ControlConflict) => void;
  /** Test switch: resolves a `physical` target to an emulator the workspace leases, driven over adb. */
  adbEmulators?: boolean;
  /** Hears each input this hub forwards, so the viewer record dates the device's last use. */
  onInput?: (device: Device) => void;
  /** Shows each touch to the device's presence subscribers. */
  presence?: Pick<PresenceHub, 'touch' | 'leave'>;
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
  private readonly changingSimulator = new Set<string>();
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
          ...(found.simulator ? { simulator: found.simulator } : {}),
          ...(found.target.physical || (found.device.platform === 'android' && found.device.physical)
            ? { physical: true }
            : {}),
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
    const helper = this.options.frameHelper();
    const simulator =
      device.platform === 'ios' && !device.physical && helper
        ? await this.pending
            .track(simulatorOptions(helper, device.udid, { action: 'read' }, this.options.env))
            .catch(() => null)
        : null;
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
    return this.open(owner, target, cwd, device, postures, granted, driver, current, beganAt, status, simulator);
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
    simulator: SimulatorOptions | null = null,
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
      simulator,
      simulatorAbort: new AbortController(),
      grab: new PointerGrab(),
      grabIdle: null,
      hostShown: false,
      startedAt: Date.now(),
      idle: setTimeout(() => void this.end(session, 'idle', 'No input for 5 minutes.'), this.options.idleMs),
      renew: setInterval(() => this.renew(session, beganAt), this.options.renewMs),
      renewing: Promise.resolve(),
      unwatch: () => {},
      adb: Promise.resolve(),
      pasteTimer: null,
      pasteTypingUntil: 0,
      ended: false,
      driver,
      driverNoticed: false,
    };
    this.sessions.set(id, session);
    this.byDevice.set(key, session);
    if (status)
      session.unwatch = this.options.subscribeStatus({
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
      ...(simulator ? { simulator } : {}),
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

  /**
   * `participant` is the viewer a share forwards the input for; it holds the device's pointer from its `down` until
   * its `up` and is told when another holds it. Input without one is the owner's own, shown as the host.
   */
  input(
    owner: Controller,
    id: string,
    command: InputCommand,
    participant?: PresenceParticipant,
  ): Promise<Refusal | BusyRefusal | SimulatorOptions | InputClipboardGetResult | InputClipboardSetResult | null> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.ended) {
      return Promise.resolve({ code: 'unknown-session', message: `No control session ${id} on this connection.` });
    }
    if (session.permitted && !session.permitted()) {
      void this.end(session, 'device-gone', 'The hosted session is no longer available.');
      return Promise.resolve({ code: 'forbidden', message: 'The hosted session is no longer available.' });
    }
    const reads = command.input === 'clipboard-get';
    if (!reads) session.idle.refresh();
    if (session.target.physical && session.lease && Date.parse(session.lease.expiresAt) <= Date.now()) {
      const message = "The workspace's lease on this device expired.";
      void this.end(session, 'device-gone', message);
      return Promise.resolve({ code: 'unknown-session', message });
    }
    if (!reads) this.options.onInput?.(session.device);
    if (command.input === 'touch') {
      const dropped = this.touch(session, command, participant);
      if (dropped !== undefined) return Promise.resolve(dropped);
    }
    if (command.input === 'simulator') return this.simulator(session, command);
    if (command.input === 'clipboard' || command.input === 'clipboard-get') return this.clipboard(session, command);
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
        command.input === 'touch' && command.display === undefined && command.duoRevision === undefined
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
        for (const args of adbInputArgs(command as Extract<InputCommand, { input: 'text' | 'button' | 'key' }>)) {
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

  private clipboard(
    session: Session,
    command: Extract<InputCommand, { input: 'clipboard' | 'clipboard-get' }>,
  ): Promise<Refusal | InputClipboardGetResult | InputClipboardSetResult | null> {
    const { device } = session;
    const set = command.input === 'clipboard' ? command : null;
    const read = async (): Promise<string> => {
      const text = await this.readClipboard(session, device);
      if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_READ_BYTES) {
        throw new Error(`The device clipboard is larger than ${MAX_CLIPBOARD_READ_BYTES} bytes.`);
      }
      return text;
    };
    const run = async (): Promise<Refusal | InputClipboardGetResult | InputClipboardSetResult | null> => {
      let reserved = false;
      try {
        if (!set) return { text: await read() };
        if (device.platform === 'ios') {
          const chunks = set.paste ? pasteTypingChunks(set.text) : null;
          if (chunks) {
            if (Date.now() < session.pasteTypingUntil) {
              return { code: 'device-busy', message: 'The device is still typing the previous paste.' };
            }
            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            session.pasteTypingUntil = Date.now() + (total / PASTE_TYPING_CHARS_PER_SECOND) * 1000;
            reserved = true;
          }
          const claim = session.claim ? takeHostedInputClaim(session.claim) : undefined;
          await runQuietly(
            simctlEnv(this.options.env),
            'xcrun',
            ['simctl', 'pbcopy', device.udid],
            'simctl pbcopy',
            CLIPBOARD_TIMEOUT_MS,
            claim,
            {
              input: set.text,
            },
          );
          if (set.paste && !session.ended) {
            if (!chunks) session.input.send({ clipboard: 'paste' });
            else {
              this.typePaste(session, chunks);
              return { typed: true };
            }
          }
        } else if (device.platform === 'android') {
          await session.input.clipboard({
            text: set.text,
            paste: set.paste && device.physical === true,
          });
          if (set.paste && !device.physical && !session.ended) {
            await runAdb(this.options.env, device.serial, ['shell', 'input', 'keyevent', 'KEYCODE_PASTE']);
          }
        }
        return null;
      } catch (cause) {
        if (reserved) session.pasteTypingUntil = 0;
        return { code: 'action-failed', message: cause instanceof Error ? cause.message : String(cause) };
      }
    };
    if (device.platform !== 'android' || device.physical) return this.pending.track(run());
    const previous = session.adb;
    const queued = previous.then(run);
    session.adb = queued.then(() => undefined);
    return this.pending.track(queued);
  }

  private typePaste(session: Session, chunks: string[]): void {
    const feed = (index: number): void => {
      session.pasteTimer = null;
      const chunk = chunks[index];
      if (session.ended || chunk === undefined) return;
      session.input.send({ input: 'text', text: chunk });
      if (index + 1 < chunks.length) {
        session.pasteTimer = setTimeout(() => feed(index + 1), (chunk.length / PASTE_TYPING_CHARS_PER_SECOND) * 1000);
      }
    };
    feed(0);
  }

  private async readClipboard(session: Session, device: Device): Promise<string> {
    if (device.platform === 'ios') {
      const claim = session.claim ? takeHostedInputClaim(session.claim) : undefined;
      return runQuietly(
        simctlEnv(this.options.env),
        'xcrun',
        ['simctl', 'pbpaste', device.udid],
        'simctl pbpaste',
        CLIPBOARD_TIMEOUT_MS,
        claim,
        {
          maxOutput: MAX_CLIPBOARD_READ_BYTES,
        },
      );
    }
    return (await session.input.clipboard(null)) ?? '';
  }

  /** Admits a touch through the pointer grab and shows it; undefined when it goes on to the device. */
  private touch(
    session: Session,
    command: TouchCommand,
    participant?: PresenceParticipant,
  ): BusyRefusal | null | undefined {
    if (participant) {
      const verdict = session.grab.admit(participant, command);
      if (!verdict.admit) {
        return verdict.busy === undefined
          ? null
          : { code: 'device-busy', message: `${verdict.busy} is using the screen.`, busy: verdict.busy };
      }
      if (session.grabIdle) clearTimeout(session.grabIdle);
      session.grabIdle = command.phase === 'up' ? null : setTimeout(() => this.expireGrab(session), GRAB_IDLE_MS);
    }
    this.show(session, participant ?? this.host(session), command);
    return undefined;
  }

  private host(session: Session): PresenceParticipant {
    session.hostShown = true;
    return { id: session.id, kind: 'host', name: 'Host', color: 0 };
  }

  private show(session: Session, who: PresenceParticipant, command: TouchCommand): void {
    const { platform, slot, physical, workspace } = session.target;
    if (!this.options.presence || (platform !== 'ios' && platform !== 'android')) return;
    this.options.presence.touch(presenceKey(workspace, platform, slot ?? 'default', physical === true), who, {
      phase: command.phase,
      x: command.x,
      y: command.y,
      ...(command.x2 !== undefined && command.y2 !== undefined ? { second: { x: command.x2, y: command.y2 } } : {}),
      ...(command.display !== undefined ? { display: command.display } : {}),
      at: Date.now(),
    });
  }

  private lift(session: Session, lifted: { holder: { id: string }; up: TouchCommand } | null): void {
    if (session.grabIdle) clearTimeout(session.grabIdle);
    session.grabIdle = null;
    if (!lifted || session.ended) return;
    session.input.send(
      lifted.up.display === undefined && lifted.up.duoRevision === undefined
        ? { ...lifted.up, display: session.frames.litDisplay(session.device) }
        : lifted.up,
    );
  }

  private expireGrab(session: Session): void {
    const lifted = session.grab.expire();
    session.grabIdle = null;
    this.lift(session, lifted);
    if (lifted) this.show(session, lifted.holder, lifted.up);
  }

  /** A participant that held the pointer left (its socket closed): lifts the pointer for it. */
  release(owner: Controller, id: string, participant: PresenceParticipant): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return;
    const lifted = session.grab.release(participant.id);
    this.lift(session, lifted);
    if (lifted) this.show(session, participant, lifted.up);
  }

  private async simulator(
    session: Session,
    command: Extract<InputCommand, { input: 'simulator' }>,
  ): Promise<SimulatorOptions | Refusal> {
    const helper = this.options.frameHelper();
    if (session.device.platform !== 'ios' || session.device.physical || !session.simulator || !helper) {
      return { code: 'action-failed', message: 'Simulator development controls are unavailable.' };
    }
    if (this.changingSimulator.has(session.key)) {
      return { code: 'device-busy', message: 'A simulator option is still changing.' };
    }
    this.changingSimulator.add(session.key);
    try {
      const result = await this.pending.track(
        simulatorOptions(helper, session.device.udid, command, this.options.env, session.simulatorAbort.signal),
      );
      if (session.ended) return { code: 'unknown-session', message: 'The control session ended.' };
      session.simulator = result;
      return result;
    } catch (cause) {
      return { code: 'action-failed', message: (cause as Error).message };
    } finally {
      this.changingSimulator.delete(session.key);
    }
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
    session.simulatorAbort.abort();
    clearTimeout(session.idle);
    clearInterval(session.renew);
    if (session.grabIdle) clearTimeout(session.grabIdle);
    if (session.pasteTimer) clearTimeout(session.pasteTimer);
    if (session.hostShown) this.hideHost(session);
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

  private hideHost(session: Session): void {
    const { platform, slot, physical, workspace } = session.target;
    if (platform === 'ios' || platform === 'android') {
      this.options.presence?.leave(presenceKey(workspace, platform, slot ?? 'default', physical === true), session.id);
    }
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
      unsubscribe = this.options.subscribeStatus({
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
    if (device.platform === 'web' || device.platform === 'macos') return null;
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
    if (target.platform !== 'ios' && target.platform !== 'android') return;
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), this.options.lockLimits.timeoutMs);
    try {
      await createStim({ projectRoot: cwd, env: this.options.env }).unlockDevice({
        platform: target.platform,
        ...(target.slot && target.slot !== 'default' ? { slot: target.slot } : {}),
        signal: abort.signal,
      });
    } catch (cause) {
      console.error(
        `stim-server: could not release the device lease: ${cause instanceof Error ? cause.message : cause}`,
      );
    } finally {
      clearTimeout(deadline);
    }
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
