import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlHub, type InputCommand } from '../src/control.ts';
import { FramePool, type Device, type DeviceInput } from '../src/frames.ts';
import { MAX_CLIPBOARD_BYTES, MAX_CLIPBOARD_READ_BYTES } from '../src/protocol.ts';

const TEXT = 'line one\nsecret "quoted" é \u{1f600}';
const owner = { device: { id: 'client', name: 'Client' }, send: () => {} };

let home: string;
let claim: ClaimHandle;
let events: string[];
let hub: ControlHub;
let frames: FramePool;
let helper: {
  clipboard: ReturnType<typeof vi.fn<DeviceInput['clipboard']>>;
  send: ReturnType<typeof vi.fn<(command: Record<string, unknown>) => void>>;
};

function fakeTool(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Records each call's arguments, locale and stdin in `calls.jsonl`, then runs `reply`. */
function recordingTool(path: string, reply: string): void {
  fakeTool(
    path,
    `const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(join(home, 'calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), lang: process.env.LC_ALL, input }) + '\\n');
  ${reply}
});
process.stdin.resume();`,
  );
}

function calls(): { args: string[]; lang: string; input: string }[] {
  try {
    return readFileSync(join(home, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function session(device: Device, env: NodeJS.ProcessEnv): Promise<string> {
  if (device.platform !== 'ios' && device.platform !== 'android') throw new Error('not a mobile device');
  frames = new FramePool(env);
  helper = {
    clipboard: vi.fn<DeviceInput['clipboard']>(async () => null),
    send: vi.fn<(command: Record<string, unknown>) => void>(),
  };
  vi.spyOn(frames, 'control').mockReturnValue({
    send: (command) => {
      events.push(`helper ${JSON.stringify(command)}`);
      helper.send(command);
    },
    keys: () => true,
    clipboard: async (request) => {
      events.push(`helper clipboard ${request ? `set paste=${request.paste}` : 'get'}`);
      return helper.clipboard(request);
    },
    detach: () => {},
  });
  hub = new ControlHub({
    frameHelper: () => null,
    env,
    stimCli: join(home, 'unused-cli.mjs'),
    frames,
    subscribeStatus: () => () => {},
    audit: (record) => events.push(`audit ${JSON.stringify(record)}`),
    lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
    idleMs: 60_000,
    renewMs: 60_000,
    leaseFor: '1m',
    foldHelper: async () => join(home, 'sim-fold'),
    foldTimeoutMs: 5000,
    conflict: () => {},
  });
  const begun = await hub.beginHosted(
    owner,
    { workspace: '/client/app', platform: device.platform },
    home,
    device,
    frames,
    () => true,
    claim,
  );
  if ('code' in begun) throw new Error(begun.message);
  return begun.session;
}

const set = (text: string, paste: boolean): InputCommand => ({ input: 'clipboard', text, paste });
const get: InputCommand = { input: 'clipboard-get' };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-clipboard-'));
  events = [];
  claim = tryAcquireClaim({ root: join(home, 'session.claims'), mode: 'exclusive' }).acquired!;
});

afterEach(async () => {
  await hub?.close();
  await frames?.close();
  vi.restoreAllMocks();
  releaseClaim(claim);
  rmSync(home, { recursive: true, force: true });
});

describe('an iOS simulator clipboard', () => {
  const device: Device = { platform: 'ios', udid: 'SIM-UDID', foldable: false };

  it('sets the text through simctl pbcopy with UTF-8 stdin, then pastes with the helper', async () => {
    recordingTool(join(home, 'bin', 'xcrun'), '');
    const id = await session(device, { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}` });
    expect(await hub.input(owner, id, set(TEXT, true))).toBeNull();
    expect(calls()).toEqual([{ args: ['simctl', 'pbcopy', 'SIM-UDID'], lang: 'en_US.UTF-8', input: TEXT }]);
    expect(events.filter((event) => event.startsWith('helper'))).toEqual(['helper {"clipboard":"paste"}']);
  });

  it('does not paste when only setting, and reads the text back through simctl pbpaste', async () => {
    recordingTool(join(home, 'bin', 'xcrun'), `process.stdout.write(${JSON.stringify(TEXT)});`);
    const id = await session(device, { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}` });
    expect(await hub.input(owner, id, set(TEXT, false))).toBeNull();
    expect(events.filter((event) => event.startsWith('helper'))).toEqual([]);
    expect(await hub.input(owner, id, get)).toEqual({ text: TEXT });
    expect(calls().map((call) => call.args)).toEqual([
      ['simctl', 'pbcopy', 'SIM-UDID'],
      ['simctl', 'pbpaste', 'SIM-UDID'],
    ]);
  });

  it('reads a clipboard larger than the set limit, up to the read limit', async () => {
    const big = 'x'.repeat(MAX_CLIPBOARD_BYTES * 2);
    recordingTool(join(home, 'bin', 'xcrun'), `process.stdout.write(${JSON.stringify(big)});`);
    const id = await session(device, { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}` });
    expect(await hub.input(owner, id, get)).toEqual({ text: big });
  });

  it('refuses a device clipboard over the read limit instead of cutting it', async () => {
    recordingTool(join(home, 'bin', 'xcrun'), `process.stdout.write('x'.repeat(${MAX_CLIPBOARD_READ_BYTES + 1}));`);
    const id = await session(device, { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}` });
    expect(await hub.input(owner, id, get)).toMatchObject({ code: 'action-failed' });
  });

  it('names a failing tool without echoing the text, and records no text in the audit trail', async () => {
    recordingTool(join(home, 'bin', 'xcrun'), `process.stderr.write('Invalid device'); process.exit(164);`);
    const id = await session(device, { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}` });
    const refused = await hub.input(owner, id, set(TEXT, true));
    expect(refused).toMatchObject({ code: 'action-failed', message: expect.stringContaining('simctl pbcopy failed') });
    expect(JSON.stringify([refused, events])).not.toContain('secret');
    expect(events.filter((event) => event.startsWith('helper'))).toEqual([]);
  });
});

describe('an Android emulator clipboard', () => {
  const device: Device = { platform: 'android', serial: 'emulator-5554' };

  function env(): NodeJS.ProcessEnv {
    const sdk = join(home, 'sdk');
    recordingTool(
      join(sdk, 'platform-tools', 'adb'),
      `fs.appendFileSync(${JSON.stringify(join(home, 'order'))}, 'adb');`,
    );
    return { ...process.env, ANDROID_HOME: sdk };
  }

  it('sets it through the helper, then pastes with a paste key event over adb', async () => {
    const id = await session(device, env());
    expect(await hub.input(owner, id, set(TEXT, true))).toBeNull();
    expect(helper.clipboard).toHaveBeenCalledWith({ text: TEXT, paste: false });
    expect(calls()).toEqual([
      { args: ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', 'KEYCODE_PASTE'], lang: undefined, input: '' },
    ]);
    expect(events.filter((event) => event.startsWith('helper'))).toEqual(['helper clipboard set paste=false']);
  });

  it('reads it through the helper, also above the set limit', async () => {
    const id = await session(device, env());
    const big = 'x'.repeat(MAX_CLIPBOARD_BYTES * 2);
    helper.clipboard.mockResolvedValue(big);
    expect(await hub.input(owner, id, get)).toEqual({ text: big });
    expect(calls()).toEqual([]);
  });

  it('does not paste when the helper could not set the clipboard, and keeps its reason without the text', async () => {
    const id = await session(device, env());
    helper.clipboard.mockRejectedValue(new Error('The emulator did not take the clipboard.'));
    expect(await hub.input(owner, id, set(TEXT, true))).toEqual({
      code: 'action-failed',
      message: 'The emulator did not take the clipboard.',
    });
    expect(calls()).toEqual([]);
  });
});

describe('an Android phone clipboard', () => {
  const device: Device = { platform: 'android', serial: 'PHONE123', physical: true };

  it('sets it with the helper paste flag and no adb call, and reads it back', async () => {
    const id = await session(device, { ...process.env, ANDROID_HOME: join(home, 'no-sdk') });
    expect(await hub.input(owner, id, set(TEXT, true))).toBeNull();
    expect(helper.clipboard).toHaveBeenCalledWith({ text: TEXT, paste: true });
    helper.clipboard.mockResolvedValue('x'.repeat(MAX_CLIPBOARD_BYTES * 2));
    expect(await hub.input(owner, id, get)).toEqual({ text: 'x'.repeat(MAX_CLIPBOARD_BYTES * 2) });
    expect(calls()).toEqual([]);
  });

  it('refuses a clipboard the phone returns over the read limit', async () => {
    const id = await session(device, { ...process.env, ANDROID_HOME: join(home, 'no-sdk') });
    helper.clipboard.mockResolvedValue('x'.repeat(MAX_CLIPBOARD_READ_BYTES + 1));
    expect(await hub.input(owner, id, get)).toMatchObject({ code: 'action-failed' });
  });
});
