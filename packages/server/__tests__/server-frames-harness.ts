import { root, workspace, start, stimCalls, authed } from './server-harness.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { readWorkspaceState, isJsonObject, workspaceStateFile } from '@stim-cli/core/state';
import { type ServerMessage } from '../src/protocol.ts';
import { type ServerOptions } from '../src/server.ts';
import { workspaceStateDir } from '@stim-cli/core';

export function jpeg(width: number, height: number, tag: string): Buffer {
  const comment = Buffer.from(tag);
  const commentLength = Buffer.alloc(2);
  commentLength.writeUInt16BE(comment.length + 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xfe]), commentLength, comment, sof, Buffer.from([0xff, 0xd9])]);
}

const FAKE_TOOL = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const env = process.env;
const args = process.argv.slice(2);
appendFileSync(env.FAKE_TOOL_CALLS, JSON.stringify({ tool: basename(process.argv[1]), args }) + '\\n');
if (env.FAKE_XCRUN_DELAYS && basename(process.argv[1]) === 'xcrun') {
  const delays = JSON.parse(env.FAKE_XCRUN_DELAYS);
  const counterFile = env.FAKE_XCRUN_DELAY_COUNTER;
  const seen = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
  writeFileSync(counterFile, String(seen + 1));
  const ms = delays[Math.min(seen, delays.length - 1)];
  if (env.FAKE_XCRUN_GATE) {
    writeFileSync(env.FAKE_XCRUN_GATE + '.' + seen + '.ready', '');
    while (!existsSync(env.FAKE_XCRUN_GATE + '.' + seen + '.release')) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } else if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
if (basename(process.argv[1]) === 'sips' && args.includes('bmp')) {
  const bmp = Buffer.alloc(58);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt16LE(24, 28);
  bmp.fill(readFileSync(args[args.indexOf('--out') - 1]).includes('BLACK') ? 0 : 255, 54, 57);
  writeFileSync(args[args.indexOf('--out') + 1], bmp);
  process.exit(0);
}
if (basename(process.argv[1]) === 'adb') process.exit(0);
if (args[0] === 'simctl' && args[1] === 'spawn' && env.FAKE_FOLD_GRANDCHILD) {
  const grandchild = require('node:child_process').spawn('sleep', ['30'], { stdio: 'inherit' });
  writeFileSync(env.FAKE_FOLD_GRANDCHILD, String(grandchild.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
}
if (args[0] === 'simctl' && args[1] === 'spawn') process.exit(0);
if (basename(process.argv[1]) === 'sips') {
  writeFileSync(args[args.indexOf('--out') + 1], Buffer.from(env.FAKE_SIPS_JPEG, 'base64'));
  process.exit(0);
}
if (env.FAKE_XCRUN_NO_PRIMARY && args.includes('--display=primary')) {
  process.stderr.write("Device does not have a 'primary' display port");
  process.exit(22);
}
if (env.FAKE_XCRUN_FAIL) {
  process.stderr.write('simctl failed on purpose');
  process.exit(2);
}
const frames = JSON.parse(env.FAKE_FRAMES);
const count = existsSync(env.FAKE_FRAME_COUNTER) ? Number(readFileSync(env.FAKE_FRAME_COUNTER, 'utf8')) : 0;
writeFileSync(env.FAKE_FRAME_COUNTER, String(count + 1));
writeFileSync(args.at(-1), Buffer.from(frames[Math.min(count, frames.length - 1)], 'base64'));
`;

const FAKE_HELPER = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const env = process.env;
const run = { tool: 'stim-frames', args: process.argv.slice(2), pid: process.pid, configs: [] };
const record = () => appendFileSync(env.FAKE_TOOL_CALLS, JSON.stringify(run) + '\\n');
if (run.args[0] !== 'simulator-options' || env.FAKE_SIMULATOR_OPTIONS) process.on('exit', record);
if (run.args[0] === 'simulator-options') {
  if (!env.FAKE_SIMULATOR_OPTIONS) process.exit(1);
  if (env.FAKE_SIMULATOR_WAIT && run.args[2] !== 'read') {
    appendFileSync(env.FAKE_TOOL_CALLS + '.option-started', String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    const options = JSON.parse(env.FAKE_SIMULATOR_OPTIONS);
    if (run.args[2] === 'slow-animations') options.slowAnimations = run.args[3] === 'on';
    process.stdout.write(JSON.stringify(options));
    process.exit(0);
  }
}
process.on('SIGTERM', () => process.exit(0));
const message = (kind, body) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = kind;
  process.stdout.write(Buffer.concat([header, body]));
};
if (env.FAKE_HELPER_KEYBOARD) message(2, Buffer.from(JSON.stringify({ keyboard: env.FAKE_HELPER_KEYBOARD })));
if (env.FAKE_HELPER_STALLED) message(2, Buffer.from(JSON.stringify({ stalled: env.FAKE_HELPER_STALLED })));
if (run.args[0] === 'macos') {
  for (const windows of [env.FAKE_HELPER_MACOS_WINDOWS, env.FAKE_HELPER_MACOS_WINDOWS_MALFORMED]) {
    if (windows) message(2, Buffer.from(JSON.stringify({ macosWindows: JSON.parse(windows) })));
  }
}
if (env.FAKE_HELPER_STALL_CLEAR_MS) {
  setTimeout(() => message(2, Buffer.from(JSON.stringify({ stalled: null }))), Number(env.FAKE_HELPER_STALL_CLEAR_MS));
}
appendFileSync(env.FAKE_TOOL_CALLS + '.started', process.pid + '\\n');
if (env.FAKE_HELPER_FAIL && !env.FAKE_HELPER_FAIL_AFTER) {
  message(2, Buffer.from(JSON.stringify({ error: env.FAKE_HELPER_FAIL })));
  process.exit(1);
}
let lines = '';
let config = {};
let keyframe = true;
let recordKeyframe = true;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lines += chunk;
  for (let at = lines.indexOf('\\n'); at >= 0; at = lines.indexOf('\\n')) {
    const line = JSON.parse(lines.slice(0, at));
    run.configs.push(line);
    if (line.input && env.FAKE_HELPER_INPUTS) appendFileSync(env.FAKE_HELPER_INPUTS, JSON.stringify(line) + '\\n');
    if (line.keyframe) keyframe = true;
    else if (line.recordKeyframe) recordKeyframe = true;
    else if (!line.input) {
      const wantsArtwork = !config.deviceFrame && line.deviceFrame;
      config = line;
      if (wantsArtwork && env.FAKE_HELPER_ARTWORK) message(2, Buffer.from(JSON.stringify({ deviceFrame: JSON.parse(env.FAKE_HELPER_ARTWORK) })));
    }
    lines = lines.slice(at + 1);
  }
});
process.stdin.on('end', () => process.exit(0));
let sent = 0;
const displays = JSON.parse(env.FAKE_HELPER_DISPLAYS ?? '[]');
setInterval(() => {
  if (typeof displays[sent] === 'number') message(2, Buffer.from(JSON.stringify({ display: displays[sent] })));
  if (config.duoFrame && env.FAKE_HELPER_DUO) {
    const metadata = Buffer.from(env.FAKE_HELPER_DUO);
    const size = Buffer.alloc(2);
    size.writeUInt16BE(metadata.length);
    message(6, Buffer.concat([size, metadata, Buffer.from('composed ' + sent)]));
  }
  if (config.video) {
    const header = Buffer.alloc(13);
    header[0] = (keyframe ? 1 : 0) | (env.FAKE_HELPER_ARTWORK ? 32 | (2 << 3) : 0);
    header.writeDoubleBE(1759000000000 + sent, 1);
    header.writeUInt16BE(588, 9);
    header.writeUInt16BE(1280, 11);
    message(3, Buffer.concat([header, Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41, sent % 256])]));
    keyframe = false;
  }
  if (config.record && !(env.FAKE_HELPER_STATIC && !recordKeyframe)) {
    const header = Buffer.alloc(13);
    header[0] = recordKeyframe || sent % 5 === 0 ? 1 : 0;
    header.writeDoubleBE(Date.now() + 0.25, 1);
    header.writeUInt16BE(332, 9);
    header.writeUInt16BE(720, 11);
    message(4, Buffer.concat([header, Buffer.from([0, 0, 0, 1, sent % 5 === 0 ? 0x65 : 0x41, sent % 256])]));
    recordKeyframe = false;
  }
  if (config.jpeg === false) return sent++;
  const size = Buffer.alloc(4);
  size.writeUInt16BE(390, 0);
  size.writeUInt16BE(844, 2);
  message(env.FAKE_HELPER_ARTWORK ? 5 : 1, Buffer.concat([size, ...(env.FAKE_HELPER_ARTWORK ? [Buffer.from([2])] : []), Buffer.from('frame ' + sent++)]));
  if (env.FAKE_HELPER_FAIL_AFTER && sent >= Number(env.FAKE_HELPER_FAIL_AFTER)) {
    message(2, Buffer.from(JSON.stringify({ error: env.FAKE_HELPER_FAIL })));
    process.exit(1);
  }
}, Number(env.FAKE_HELPER_INTERVAL_MS ?? 50));
`;

export function statusPayload(devices: Record<string, unknown>): unknown {
  return {
    environments: [{ path: workspace, live: true, memoryMb: 0, warnings: [], ...devices }],
    capacity: { liveCount: 1, committedMb: 0, totalMemoryMb: 1, overCapacity: false },
    deviceLeases: [],
    unprovisionedWorktrees: [],
    simctlAvailable: true,
  };
}

export function statusWith(devices: Record<string, unknown>): string {
  return JSON.stringify([statusPayload(devices)]);
}

export const OWNED_SIM = { name: 'stim-app (iPhone 17 27.0)', udid: 'SIM-1', owned: true, state: 'Booted' };

export const OWNED_WEB = {
  browser: 'chrome',
  version: 'Chrome/153.0.8010.49',
  running: true,
  pid: 4242,
  supervisorPid: 4241,
  url: 'http://localhost:8081/',
  headless: true,
  viewport: 'desktop',
  profile: '/stim/web/profile',
  cdpEndpoint: 'http://127.0.0.1:8900',
  targetId: 'PAGE-1',
};

export const OWNED_MACOS: Record<string, unknown> = {
  launchId: 'LAUNCH-1',
  product: 'MyApp',
  arguments: [],
  bundle: '/stim/macos/MyApp.app',
  bundleId: 'dev.myapp.stim.workspace',
  executable: '/stim/macos/MyApp.app/Contents/MacOS/MyApp',
  state: 'running',
  build: { state: 'ok', startedAt: '2026-10-04T12:00:00Z' },
  app: { pid: 4242, startedAtMicros: 123456, processToken: 'owned-process' },
};
export let toolCalls: string;

export async function startWithTools(
  env: Record<string, string>,
  frameLimits?: ServerOptions['frameLimits'],
  frameHelper?: string,
  recording?: Pick<ServerOptions, 'record' | 'recordLimits' | 'actionLimits' | 'foldHelper'>,
): Promise<number> {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['xcrun', 'sips']) {
    writeFileSync(join(bin, tool), FAKE_TOOL);
    chmodSync(join(bin, tool), 0o755);
  }
  toolCalls = join(root, 'tools.ndjson');
  return start({
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_TOOL_CALLS: toolCalls,
      FAKE_FRAME_COUNTER: join(root, 'frame-counter'),
      ...env,
    },
    frameLimits,
    frameHelper,
    ...recording,
  });
}

export function toolRuns(): { tool: string; args: string[] }[] {
  if (!existsSync(toolCalls)) return [];
  return readFileSync(toolCalls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; args: string[] });
}

export function fakeHelper(): string {
  const helper = join(root, 'stim-frames');
  writeFileSync(helper, FAKE_HELPER);
  chmodSync(helper, 0o755);
  return helper;
}

type HelperRun = { args: string[]; pid: number; configs: Record<string, unknown>[] };

export function helperRuns(): HelperRun[] {
  return toolRuns()
    .filter((run) => run.tool === 'stim-frames')
    .map((run) => run as unknown as HelperRun);
}

export function leasedPhonePayload(deviceName: string | null = 'Old iPhone'): string {
  const lease = { platform: 'ios', deviceName: null, grantedAt: null, expiresAt: null, mine: false, parsed: true };
  return JSON.stringify([
    {
      ...(statusPayload({ ios: OWNED_SIM }) as object),
      deviceLeases: [
        { ...lease, path: '/locks/other', id: 'PHONE-OTHER', holder: '/elsewhere', expired: false },
        { ...lease, path: '/locks/old', id: 'PHONE-OLD', holder: workspace, expired: true },
        { ...lease, path: '/locks/sim', id: 'SIM-1', holder: workspace, expired: false },
        { ...lease, path: '/locks/slot', id: 'PHONE-SLOT', slot: 'tablet', holder: workspace, expired: false },
        {
          ...lease,
          path: '/locks/phone',
          id: 'PHONE-1',
          deviceName,
          holder: workspace,
          expired: false,
        },
      ],
    },
  ]);
}

async function fakeChrome(browserPid: number): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const http = createHttpServer((_, response) => {
    const { port } = http.address() as { port: number };
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/B` }));
  });
  const sockets = new WebSocketServer({ server: http });
  let shot = 0;
  sockets.on('connection', (socket) =>
    socket.on('message', (data) => {
      const { id, method, sessionId } = JSON.parse(String(data)) as {
        id: number;
        method: string;
        sessionId?: string;
      };
      const result =
        method === 'SystemInfo.getProcessInfo'
          ? { processInfo: [{ type: 'browser', id: browserPid }] }
          : method === 'Target.attachToTarget'
            ? { sessionId: 'S1' }
            : method === 'Page.captureScreenshot' && sessionId === 'S1'
              ? { data: jpeg(1280, 800, `page ${shot++}`).toString('base64') }
              : {};
      socket.send(JSON.stringify({ id, result }));
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        sockets.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

export async function subscribeToFakeChrome(browserPid: number): Promise<ServerMessage> {
  const chrome = await fakeChrome(browserPid);
  try {
    const port = await startWithTools({
      FAKE_STIM_PAYLOADS: JSON.stringify([statusPayload({ web: { ...OWNED_WEB, cdpEndpoint: chrome.endpoint } })]),
      FAKE_FRAMES: '[]',
    });
    const client = await authed(port);
    await client.request('frames.subscribe', { workspace, platform: 'web' });
    const message = await client.next();
    client.socket.close();
    return message;
  } finally {
    await chrome.close();
  }
}

export const OWNED_EMULATOR = {
  name: 'stim-app',
  owned: true,
  physical: false,
  serial: 'emulator-5554',
  state: 'detected',
};

export async function startControl(
  env: Record<string, string> = {},
  controlLimits?: ServerOptions['controlLimits'],
  pushEndpoint?: string,
  hostedRelay?: ServerOptions['hostedRelay'],
): Promise<number> {
  writeFileSync(join(workspace, 'package.json'), '{}');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['xcrun', 'sips', 'adb']) {
    writeFileSync(join(bin, tool), FAKE_TOOL);
    chmodSync(join(bin, tool), 0o755);
  }
  toolCalls = join(root, 'tools.ndjson');
  const home = join(root, 'fake-home');
  mkdirSync(home);
  return start({
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      ANDROID_HOME: '',
      ANDROID_SDK_ROOT: '',
      FAKE_TOOL_CALLS: toolCalls,
      FAKE_FRAME_COUNTER: join(root, 'frame-counter'),
      FAKE_FRAMES: '[]',
      FAKE_STIM_PAYLOADS: statusWith({ ios: OWNED_SIM, android: OWNED_EMULATOR }),
      ...env,
    },
    frameHelper: fakeHelper(),
    foldHelper: join(root, 'sim-fold'),
    controlLimits,
    pushEndpoint,
    hostedRelay,
  });
}

export function lockCalls(): string[] {
  return stimCalls()
    .map((call) => call.args)
    .filter((args) => args.startsWith('device '));
}

export function controlLease(
  holder: string,
  id: string,
  platform: string = 'ios',
  slot: string = 'default',
): { path: string; lock: string } {
  const directory = join(process.env.STIM_HOME!, 'device-locks');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${platform}-${id}.json`);
  const token = randomUUID();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      platform,
      id,
      holder,
      slot,
      token,
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }),
  );
  mkdirSync(workspaceStateDir(holder), { recursive: true });
  const state = readWorkspaceState(holder) ?? {};
  writeFileSync(
    workspaceStateFile(holder),
    JSON.stringify({
      ...state,
      deviceLeases: {
        ...(isJsonObject(state.deviceLeases) ? state.deviceLeases : {}),
        [slot === 'default' ? platform : `${platform}:${slot}`]: { id, token, kind: 'declared' },
      },
    }),
  );
  return { path, lock: join(directory, `${platform}-${id}.lock`) };
}

export function leasedPhone(leases: Record<string, unknown>[]): string {
  const lease = {
    path: '/stim/device-locks/android.json',
    platform: 'android',
    deviceName: 'Pixel 8',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    mine: false,
    expired: false,
    parsed: true,
  };
  const payload = statusPayload({ android: OWNED_EMULATOR }) as Record<string, unknown>;
  return JSON.stringify([
    { ...payload, deviceLeases: leases.map((entry) => ({ ...lease, holder: workspace, ...entry })) },
  ]);
}
