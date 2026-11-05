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
/** A touch dropped because another participant holds the device's pointer; `busy` is that participant's name. */
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

/** The keys a physical Android phone takes as `input.key`: the arrows and Escape, without modifiers. */
const DEVICE_KEYS = ['left', 'right', 'up', 'down', 'escape'] as const;
type DeviceKey = (typeof DEVICE_KEYS)[number];

function isDeviceKey(key: unknown): key is DeviceKey {
  return DEVICE_KEYS.some((candidate) => candidate === key);
}

/** Whether an `input.key` goes beyond the arrows and Escape without modifiers, which only a `device-keyboard` host takes. */
export function isExtendedDeviceKey(key: unknown, modifiers: unknown): boolean {
  return !isDeviceKey(key) || (Array.isArray(modifiers) && modifiers.length > 0);
}

const IOS_BUTTONS: readonly InputButton[] = ['home', 'lock'];
const WEB_BUTTONS: readonly InputButton[] = ['back'];

function delta(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000;
}

function fraction(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function parseKey(
  session: string,
  params: Record<string, unknown>,
): Parsed<{ session: string; command: InputCommand }> {
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

function parseDeviceKey(
  session: string,
  platform: 'ios' | 'android',
  physical: boolean,
  params: Record<string, unknown>,
): Parsed<{ session: string; command: InputCommand }> {
  if (!physical) return parseKey(session, params);
  const { key, modifiers = [] } = params;
  if (!isDeviceKey(key) || !Array.isArray(modifiers) || modifiers.length) {
    return {
      code: 'bad-request',
      message: `An ${platform === 'ios' ? 'iOS' : 'Android'} phone takes the keys ${DEVICE_KEYS.join(', ')}, without modifiers.`,
    };
  }
  return { value: { session, command: { input: 'key', key, modifiers: [] } } };
}

function parseScrollOrKey(
  method: 'input.scroll' | 'input.key',
  session: string,
  platform: ControlPlatform,
  physical: boolean,
  params: Record<string, unknown>,
): Parsed<{ session: string; command: InputCommand }> {
  if (platform !== 'macos' && method === 'input.key' && platform !== 'web') {
    return parseDeviceKey(session, platform, physical, params);
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
  return parseKey(session, params);
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
  if (method === 'input.scroll' || method === 'input.key')
    return parseScrollOrKey(method, session, platform, target.physical === true, params);
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

/** Command acts as Control on Android, where Control is the shortcut key, as Command is on a Mac. */
const ANDROID_MODIFIERS: Record<KeyModifier, string> = {
  command: 'KEYCODE_CTRL_LEFT',
  control: 'KEYCODE_CTRL_LEFT',
  option: 'KEYCODE_ALT_LEFT',
  shift: 'KEYCODE_SHIFT_LEFT',
};

const ANDROID_NAMED_KEYS: Partial<Record<InputKey, string>> = {
  escape: 'KEYCODE_ESCAPE',
  tab: 'KEYCODE_TAB',
  return: 'KEYCODE_ENTER',
  backspace: 'KEYCODE_DEL',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
};

function androidKeycode(key: InputKey): string {
  return ANDROID_NAMED_KEYS[key] ?? `KEYCODE_${key.toUpperCase()}`;
}

/**
 * The `adb shell` argument lists that type `text` or press `button` on an emulator without a hardware keyboard
 * (`hw.keyboard=no`), which drops gRPC key events. `adb shell` joins its arguments into one device shell
 * command, so text goes single-quoted; `input text` reads `%s` as a space.
 */
export function adbInputArgs(command: Extract<InputCommand, { input: 'text' | 'button' | 'key' }>): string[][] {
  if (command.input === 'button') return [['shell', 'input', 'keyevent', ANDROID_KEYS[command.button]]];
  if (command.input === 'key') {
    const key = androidKeycode(command.key);
    const modifiers = [...new Set(command.modifiers.map((modifier) => ANDROID_MODIFIERS[modifier]))];
    return [['shell', 'input', ...(modifiers.length ? ['keycombination', ...modifiers] : ['keyevent']), key]];
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

/**
 * Takes `cost` from a token bucket refilled at `perSecond` up to `capacity`. A caller may let the bucket go up to
 * `debt` below zero, so an input that must arrive still does while a stream of others has drained it.
 */
export function take(
  bucket: { tokens: number; at: number },
  cost: number,
  perSecond: number,
  capacity: number,
  debt = 0,
): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
  bucket.at = now;
  if (bucket.tokens - cost < -debt) return false;
  bucket.tokens -= cost;
  return true;
}

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

/** Who holds a device's pointer: a share viewer, or a session's own controller shown as the host. */
interface Holder {
  id: string;
  name: string;
  who: PresenceParticipant;
  session: string;
}

/**
 * What every control session on one device shares: the lease, the `stim-frames` input, the pointer and the
 * paste typing. The first session opens it and the last one to end closes it.
 */
interface DeviceControl {
  key: string;
  device: Device;
  target: ControlBeginParams;
  cwd: string;
  beganAt: number;
  lease: Lease | null;
  /** Why `stim device lock` refused, when the first session took the device over without the lease. */
  leaseRefused: Refusal | null;
  input: DeviceInput;
  frames: FramePool;
  claim?: ClaimHandle;
  postures: DevicePosture[];
  simulator: SimulatorOptions | null;
  simulatorAbort: AbortController;
  grab: PointerGrab<Holder, TouchCommand>;
  grabIdle: NodeJS.Timeout | null;
  sessions: Set<Session>;
  renew: NodeJS.Timeout;
  unwatch: () => void;
  renewing: Promise<void>;
  adb: Promise<void>;
  pasteTimer: NodeJS.Timeout | null;
  pasteTypingUntil: number;
  closed: boolean;
}

interface Session {
  id: string;
  owner: Controller;
  control: DeviceControl;
  target: ControlBeginParams;
  permitted?: () => boolean;
  /** Whether the session's own controller, not a participant it forwards, published a touch as the host. */
  hostShown: boolean;
  startedAt: number;
  idle: NodeJS.Timeout;
  ended: boolean;
  /** The driver the device had when this session began, and whether another one was already pushed to the owner. */
  driver: string | null;
  driverNoticed: boolean;
  deviceKeyboard?: boolean;
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
  /** Tells the paired device `deviceId` that an agent or another tool started driving the device it controls. */
  conflict: (deviceId: string, conflict: ControlConflict) => void;
  /** Test switch: resolves a `physical` target to an emulator the workspace leases, driven over adb. */
  adbEmulators?: boolean;
  /** Hears each input this hub forwards, so the viewer record dates the device's last use. */
  onInput?: (device: Device) => void;
  /** Shows each touch to the device's presence subscribers. */
  presence?: Pick<PresenceHub, 'touch' | 'leave'>;
}

const STATUS_WAIT_MS = 60_000;

type Opened = { control: DeviceControl } | Refusal;

/**
 * Control sessions across all connections. Any number of sessions control one device at once; they share the
 * device's `stim-frames` helper for input and one pointer, which a touch `down` holds until its `up`. Ordinary
 * devices hold a `stim device lock` lease while any session lasts, renewed and released by the hub when it took
 * it. Hosted sessions use their native session's ownership claim instead.
 */
export class ControlHub {
  private readonly options: ControlOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly byDevice = new Map<string, DeviceControl>();
  private readonly opening = new Map<string, Promise<Opened>>();
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly ownLeases = new Set<string>();
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
    if (!found || found.owner !== owner || found.ended) return null;
    const { control } = found;
    return {
      platform: found.target.platform,
      postures: control.postures,
      ...(control.simulator ? { simulator: control.simulator } : {}),
      ...(found.target.physical || (control.device.platform === 'android' && control.device.physical)
        ? { physical: true }
        : {}),
    };
  }

  /**
   * `stillAllowed` is checked again after the status read and the lock, which can take seconds: the client may
   * have disconnected or lost `control` meanwhile. Another client controlling the device, or an agent driving it,
   * does not refuse; `takeOver` only lets a simulator or emulator be controlled without the lease another
   * workspace holds.
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
    if (target.physical) {
      const held = heldLease(status, target, resolve);
      if ('code' in held) return held;
    }
    const driver = otherDriver(activityOf(status, target), this.ownLeases);
    for (;;) {
      const opened = await this.deviceControl(deviceKey(device), () =>
        this.openDevice(device, target, cwd, beganAt, status),
      );
      if ('code' in opened) return opened;
      if (this.closing || !stillAllowed()) {
        void this.closeIfUnused(opened.control);
        return { code: 'forbidden', message: 'This device can no longer control devices.' };
      }
      if (opened.control.leaseRefused && !target.takeOver) {
        void this.closeIfUnused(opened.control);
        return opened.control.leaseRefused;
      }
      if (!opened.control.closed) return this.join(opened.control, owner, target, driver);
    }
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
    for (;;) {
      const opened = await this.deviceControl(deviceKey(device), () =>
        this.openHosted(device, target, cwd, frames, claim),
      );
      if ('code' in opened) return opened;
      if (this.closing || !stillAllowed()) {
        void this.closeIfUnused(opened.control);
        return { code: 'forbidden', message: 'This hosted session can no longer be controlled.' };
      }
      if (!opened.control.closed) return this.join(opened.control, owner, target, null, stillAllowed);
    }
  }

  /**
   * The device's open control, or the one being opened, so concurrent `begin`s share one lease and input. A control
   * can close before its caller resumes, when every other caller gave up; the caller then opens it again.
   */
  private async deviceControl(key: string, open: () => Promise<Opened>): Promise<Opened> {
    const current = this.byDevice.get(key);
    if (current) return { control: current };
    const starting = this.opening.get(key);
    if (starting) {
      const outcome = await starting;
      return 'code' in outcome ? this.deviceControl(key, open) : outcome;
    }
    const attempt = this.pending.track(
      (async () => {
        await this.releasing.get(key);
        return open();
      })(),
    );
    this.opening.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (this.opening.get(key) === attempt) this.opening.delete(key);
    }
  }

  private async openDevice(
    device: Device,
    target: ControlBeginParams,
    cwd: string,
    beganAt: number,
    status: StatusPayload,
  ): Promise<Opened> {
    const resolve = { adbEmulators: this.options.adbEmulators === true };
    const [lease, postures] = await Promise.all([
      target.physical ? Promise.resolve(heldLease(status, target, resolve)) : this.lock(device, target, cwd, beganAt),
      devicePostures(device, this.options.env, POSTURE_TIMEOUT_MS),
    ]);
    const helper = this.options.frameHelper();
    const simulator =
      device.platform === 'ios' && !device.physical && helper
        ? await simulatorOptions(helper, device.udid, { action: 'read' }, this.options.env).catch(() => null)
        : null;
    const granted = lease === null || 'code' in lease ? null : lease;
    if (lease !== null && !granted && (!target.takeOver || target.physical)) return lease as Refusal;
    const opened = this.open(device, target, cwd, beganAt, postures, granted, simulator, this.options.frames);
    if (!('code' in opened) && lease !== null && 'code' in lease) opened.control.leaseRefused = lease;
    if ('code' in opened) {
      if (granted?.mine) void this.pending.track(this.unlock(target, cwd));
      return opened;
    }
    const control = opened.control;
    control.unwatch = this.options.subscribeStatus({
      item: (payload) => this.statusChanged(control, payload as unknown as StatusPayload),
      failed: () => {},
    });
    return opened;
  }

  private openHosted(
    device: Device,
    target: ControlBeginParams,
    cwd: string,
    frames: FramePool,
    claim: ClaimHandle,
  ): Promise<Opened> {
    return devicePostures(device, this.options.env, POSTURE_TIMEOUT_MS).then((postures) =>
      this.open(device, target, cwd, Date.now(), postures, null, null, frames, claim),
    );
  }

  private open(
    device: Device,
    target: ControlBeginParams,
    cwd: string,
    beganAt: number,
    postures: DevicePosture[],
    lease: Lease | null,
    simulator: SimulatorOptions | null,
    frames: FramePool,
    claim?: ClaimHandle,
  ): Opened {
    if (this.closing) return { code: 'action-failed', message: 'stim-server is stopping.' };
    let control: DeviceControl;
    const input = frames.control(device, (message) => queueMicrotask(() => this.endAll(control, 'failed', message)));
    if (!input) {
      return { code: 'action-failed', message: 'Input needs the stim-frames helper, which this Mac has not built.' };
    }
    const key = deviceKey(device);
    control = {
      key,
      device,
      target,
      cwd,
      beganAt,
      lease,
      leaseRefused: null,
      input,
      frames,
      ...(claim ? { claim } : {}),
      postures,
      simulator,
      simulatorAbort: new AbortController(),
      grab: new PointerGrab(),
      grabIdle: null,
      sessions: new Set(),
      renew: setInterval(() => this.renew(control), this.options.renewMs),
      unwatch: () => {},
      renewing: Promise.resolve(),
      adb: Promise.resolve(),
      pasteTimer: null,
      pasteTypingUntil: 0,
      closed: false,
    };
    this.byDevice.set(key, control);
    return { control };
  }

  private join(
    control: DeviceControl,
    owner: Controller,
    target: ControlBeginParams,
    driver: string | null,
    permitted?: () => boolean,
  ): ControlBeginResult {
    const id = `c${this.next++}`;
    const session: Session = {
      id,
      owner,
      control,
      target,
      ...(permitted ? { permitted } : {}),
      hostShown: false,
      startedAt: Date.now(),
      idle: setTimeout(() => void this.end(session, 'idle', 'No input for 5 minutes.'), this.options.idleMs),
      ended: false,
      driver,
      driverNoticed: false,
    };
    this.sessions.set(id, session);
    control.sessions.add(session);
    this.audit(owner, target, 'control.begin', { ok: true });
    return {
      session: id,
      platform: target.platform,
      lease: control.lease ? { grantedAt: control.lease.grantedAt, expiresAt: control.lease.expiresAt } : null,
      postures: control.postures,
      ...(control.simulator ? { simulator: control.simulator } : {}),
    };
  }

  private statusChanged(control: DeviceControl, latest: StatusPayload): void {
    if (control.closed) return;
    const { target, key } = control;
    const resolve = { adbEmulators: this.options.adbEmulators === true };
    const resolved = ownedDevice(latest, target, key, resolve);
    if (target.physical && control.lease && typeof resolved !== 'string') {
      control.lease.expiresAt = workspaceLease(latest, target, resolve)?.expiresAt ?? control.lease.expiresAt;
    }
    if (typeof resolved === 'string' || deviceKey(resolved) !== key) {
      const message = typeof resolved === 'string' ? resolved : 'The device changed.';
      queueMicrotask(() => this.endAll(control, 'device-gone', message));
      return;
    }
    const other = otherDriver(activityOf(latest, target), this.ownLeases);
    if (!other) return;
    const tool = activityOf(latest, target)?.driver?.tool ?? 'An agent';
    for (const session of control.sessions) {
      if (other === session.driver || session.driverNoticed || session.ended) continue;
      session.driverNoticed = true;
      this.options.conflict(session.owner.device.id, {
        ...conflictAbout(latest, target),
        body: `${tool} started driving the ${DEVICE_NOUN[target.platform]} you are controlling`,
      });
    }
  }

  private renew(control: DeviceControl): void {
    if (control.closed || !control.lease?.mine) return;
    control.renewing = this.pending.track(
      (async () => {
        const renewed = await this.lock(control.device, control.target, control.cwd, control.beganAt);
        if (renewed === null) return;
        if ('code' in renewed) console.error(`stim-server: could not renew the device lease: ${renewed.message}`);
        else if (control.lease) control.lease.expiresAt = renewed.expiresAt;
      })(),
    );
  }

  /**
   * `participant` is the viewer a share forwards the input for. Input without one is the session's own, shown as
   * the host. A touch `down` holds the device's pointer for its participant until that participant's `up`; touches
   * from anyone else meanwhile are dropped, and the one that turned a `down` away is named.
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
    const { control } = session;
    if (session.permitted && !session.permitted()) {
      void this.end(session, 'device-gone', 'The hosted session is no longer available.');
      return Promise.resolve({ code: 'forbidden', message: 'The hosted session is no longer available.' });
    }
    const reads = command.input === 'clipboard-get';
    if (!reads) session.idle.refresh();
    if (control.target.physical && control.lease && Date.parse(control.lease.expiresAt) <= Date.now()) {
      const message = "The workspace's lease on this device expired.";
      this.endAll(control, 'device-gone', message);
      return Promise.resolve({ code: 'unknown-session', message });
    }
    if (!reads) this.options.onInput?.(control.device);
    if (command.input === 'touch') {
      const dropped = this.touch(session, command, participant);
      if (dropped !== undefined) return Promise.resolve(dropped);
    }
    if (command.input === 'simulator') return this.simulator(control, command);
    if (command.input === 'clipboard' || command.input === 'clipboard-get') return this.clipboard(control, command);
    if (command.input === 'posture' && control.device.platform === 'ios') {
      const udid = control.device.udid;
      if (this.folding.has(udid))
        return Promise.resolve({ code: 'device-busy', message: 'The device is still folding.' });
      const folded = this.fold(control, udid, command.posture);
      const settled = folded.then(() => {
        this.folding.delete(udid);
        return undefined;
      });
      this.folding.set(udid, settled);
      control.adb = settled;
      return folded;
    }
    if (
      control.device.platform !== 'android' ||
      control.device.physical ||
      command.input === 'touch' ||
      command.input === 'rotate' ||
      command.input === 'posture' ||
      (control.input.keys() && !(command.input === 'key' && isExtendedDeviceKey(command.key, command.modifiers)))
    ) {
      control.input.send(
        command.input === 'touch' && command.display === undefined && command.duoRevision === undefined
          ? { ...command, display: control.frames.litDisplay(control.device) }
          : command,
      );
      return Promise.resolve(null);
    }
    const serial = control.device.serial;
    const previous = control.adb;
    const run = (async (): Promise<Refusal | null> => {
      await previous;
      try {
        for (const args of adbInputArgs(command as Extract<InputCommand, { input: 'text' | 'button' | 'key' }>)) {
          if (control.closed) return null;
          await runAdb(this.options.env, serial, args);
        }
        return null;
      } catch (cause) {
        return { code: 'action-failed', message: (cause as Error).message };
      }
    })();
    control.adb = run.then(() => undefined);
    return this.pending.track(run);
  }

  private clipboard(
    control: DeviceControl,
    command: Extract<InputCommand, { input: 'clipboard' | 'clipboard-get' }>,
  ): Promise<Refusal | InputClipboardGetResult | InputClipboardSetResult | null> {
    const { device } = control;
    const set = command.input === 'clipboard' ? command : null;
    const read = async (): Promise<string> => {
      const text = await this.readClipboard(control, device);
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
            if (Date.now() < control.pasteTypingUntil) {
              return { code: 'device-busy', message: 'The device is still typing the previous paste.' };
            }
            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            control.pasteTypingUntil = Date.now() + (total / PASTE_TYPING_CHARS_PER_SECOND) * 1000;
            reserved = true;
          }
          const claim = control.claim ? takeHostedInputClaim(control.claim) : undefined;
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
          if (set.paste && !control.closed) {
            if (!chunks) control.input.send({ clipboard: 'paste' });
            else {
              this.typePaste(control, chunks);
              return { typed: true };
            }
          }
        } else if (device.platform === 'android') {
          await control.input.clipboard({
            text: set.text,
            paste: set.paste && device.physical === true,
          });
          if (set.paste && !device.physical && !control.closed) {
            await runAdb(this.options.env, device.serial, ['shell', 'input', 'keyevent', 'KEYCODE_PASTE']);
          }
        }
        return null;
      } catch (cause) {
        if (reserved) control.pasteTypingUntil = 0;
        return { code: 'action-failed', message: cause instanceof Error ? cause.message : String(cause) };
      }
    };
    if (device.platform !== 'android' || device.physical) return this.pending.track(run());
    const previous = control.adb;
    const queued = previous.then(run);
    control.adb = queued.then(() => undefined);
    return this.pending.track(queued);
  }

  private typePaste(control: DeviceControl, chunks: string[]): void {
    const feed = (index: number): void => {
      control.pasteTimer = null;
      const chunk = chunks[index];
      if (control.closed || chunk === undefined) return;
      control.input.send({ input: 'text', text: chunk });
      if (index + 1 < chunks.length) {
        control.pasteTimer = setTimeout(() => feed(index + 1), (chunk.length / PASTE_TYPING_CHARS_PER_SECOND) * 1000);
      }
    };
    feed(0);
  }

  private async readClipboard(control: DeviceControl, device: Device): Promise<string> {
    if (device.platform === 'ios') {
      const claim = control.claim ? takeHostedInputClaim(control.claim) : undefined;
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
    return (await control.input.clipboard(null)) ?? '';
  }

  /** Admits a touch through the device's pointer and shows it; undefined when it goes on to the device. */
  private touch(
    session: Session,
    command: TouchCommand,
    participant?: PresenceParticipant,
  ): BusyRefusal | null | undefined {
    const { control } = session;
    const who = participant ?? this.host(session);
    const verdict = control.grab.admit({ id: who.id, name: who.name, who, session: session.id }, command);
    if (!verdict.admit) {
      return verdict.busy === undefined
        ? null
        : { code: 'device-busy', message: `${verdict.busy} is using the screen.`, busy: verdict.busy };
    }
    if (control.grabIdle) clearTimeout(control.grabIdle);
    control.grabIdle = command.phase === 'up' ? null : setTimeout(() => this.expireGrab(control), GRAB_IDLE_MS);
    this.show(session.target, who, command);
    return undefined;
  }

  private host(session: Session): PresenceParticipant {
    session.hostShown = true;
    return { id: session.id, kind: 'host', name: 'Host', color: 0 };
  }

  private show(target: ControlBeginParams, who: PresenceParticipant, command: TouchCommand): void {
    const { platform, slot, physical, workspace } = target;
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

  /** Sends the `up` that lifts the pointer for a holder that left, and shows it. */
  private lift(control: DeviceControl, lifted: { holder: Holder; up: TouchCommand } | null): void {
    if (control.grabIdle) clearTimeout(control.grabIdle);
    control.grabIdle = null;
    if (!lifted || control.closed) return;
    control.input.send(
      lifted.up.display === undefined && lifted.up.duoRevision === undefined
        ? { ...lifted.up, display: control.frames.litDisplay(control.device) }
        : lifted.up,
    );
    this.show(control.target, lifted.holder.who, lifted.up);
  }

  private expireGrab(control: DeviceControl): void {
    control.grabIdle = null;
    this.lift(control, control.grab.expire());
  }

  /** A participant that held the pointer left (its socket closed): lifts the pointer for it. */
  release(owner: Controller, id: string, participant: PresenceParticipant): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return;
    this.lift(session.control, session.control.grab.release(participant.id));
  }

  /**
   * Tells the helper of an iOS simulator whether its on-screen keyboard shows: `enabled` detaches the hardware keyboard
   * and stops input attaching it again. Does nothing without such a session.
   */
  deviceKeyboard(owner: Controller, id: string, enabled: boolean): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.ended) return;
    const { control } = session;
    if (control.device.platform !== 'ios' || control.device.physical) return;
    session.deviceKeyboard = enabled;
    control.input.send({ input: 'deviceKeyboard', enabled });
  }

  private async simulator(
    control: DeviceControl,
    command: Extract<InputCommand, { input: 'simulator' }>,
  ): Promise<SimulatorOptions | Refusal> {
    const helper = this.options.frameHelper();
    if (control.device.platform !== 'ios' || control.device.physical || !control.simulator || !helper) {
      return { code: 'action-failed', message: 'Simulator development controls are unavailable.' };
    }
    if (this.changingSimulator.has(control.key)) {
      return { code: 'device-busy', message: 'A simulator option is still changing.' };
    }
    this.changingSimulator.add(control.key);
    try {
      const result = await this.pending.track(
        simulatorOptions(helper, control.device.udid, command, this.options.env, control.simulatorAbort.signal),
      );
      if (control.closed) return { code: 'unknown-session', message: 'The control session ended.' };
      control.simulator = result;
      return result;
    } catch (cause) {
      return { code: 'action-failed', message: (cause as Error).message };
    } finally {
      this.changingSimulator.delete(control.key);
    }
  }

  /**
   * `sim-fold` sweeps the hinge to the other posture, so it runs only when the Duo's last frame shows the
   * other one.
   */
  private async fold(control: DeviceControl, udid: string, posture: DevicePosture): Promise<Refusal | null> {
    const current = control.frames.litPosture(control.device);
    if (!current) {
      return { code: 'action-failed', message: 'Subscribe to frames of this device to learn its posture first.' };
    }
    if (current === posture) return null;
    try {
      const helper = await this.options.foldHelper();
      if (control.closed) return null;
      await this.pending.track(
        runQuietly(
          this.options.env,
          'xcrun',
          ['simctl', 'spawn', udid, helper],
          'sim-fold',
          this.options.foldTimeoutMs,
          control.claim ? takeHostedInputClaim(control.claim) : undefined,
        ),
      );
      control.frames.folded(udid, posture === 'folded' ? 'folded' : 'unfolded');
      return null;
    } catch (cause) {
      return { code: 'action-failed', message: (cause as Error).message };
    }
  }

  endById(owner: Controller, id: string, message = 'The client ended the session.'): boolean {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) return false;
    void this.end(session, null, message);
    return true;
  }

  endFor(owner: Controller, reason: ControlEndedEvent['reason'] | null, message: string): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) void this.end(session, reason, message);
    }
  }

  async endDevice(device: Device, message: string): Promise<void> {
    const control = this.byDevice.get(deviceKey(device));
    if (control) {
      await this.endAll(control, 'device-gone', message);
      await control.adb;
    }
    if (device.platform === 'ios') await this.folding.get(device.udid);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const session of this.sessions.values()) void this.end(session, null, 'stim-server stopped.');
    await this.pending.settled();
  }

  private endAll(control: DeviceControl, reason: ControlEndedEvent['reason'], message: string): Promise<void> {
    return Promise.all([...control.sessions].map((session) => this.end(session, reason, message))).then(
      () => undefined,
    );
  }

  private end(session: Session, reason: ControlEndedEvent['reason'] | null, message: string): Promise<void> {
    if (session.ended) return Promise.resolve();
    session.ended = true;
    clearTimeout(session.idle);
    const { control } = session;
    if (control.grab.holder?.session === session.id) this.lift(control, control.grab.expire());
    if (session.hostShown) this.hideHost(session);
    this.sessions.delete(session.id);
    control.sessions.delete(session);
    if (session.deviceKeyboard) control.input.send({ input: 'deviceKeyboard', enabled: false });
    if (reason) session.owner.send({ event: 'control-ended', session: session.id, reason, message });
    this.audit(session.owner, session.target, 'control.end', {
      ok: true,
      durationMs: Date.now() - session.startedAt,
      reason: `${reason ?? 'ended'}: ${message}`,
    });
    return this.closeIfUnused(control);
  }

  /** Closes a device control no session uses: detaches its input and releases the lease the hub took. */
  private closeIfUnused(control: DeviceControl): Promise<void> {
    if (control.closed || control.sessions.size) return Promise.resolve();
    control.closed = true;
    control.simulatorAbort.abort();
    clearInterval(control.renew);
    if (control.grabIdle) clearTimeout(control.grabIdle);
    if (control.pasteTimer) clearTimeout(control.pasteTimer);
    control.unwatch();
    control.input.detach();
    if (this.byDevice.get(control.key) === control) this.byDevice.delete(control.key);
    if (!control.lease?.mine) return Promise.resolve();
    const released: Promise<void> = this.pending.track(
      control.renewing
        .then(() => this.unlock(control.target, control.cwd))
        .finally(() => {
          if (this.releasing.get(control.key) === released) this.releasing.delete(control.key);
        }),
    );
    this.releasing.set(control.key, released);
    return released;
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
