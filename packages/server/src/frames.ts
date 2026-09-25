import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type ClientHttp2Session } from 'node:http2';
import { join } from 'node:path';
import type { StatusPayload } from '@stim-cli/core/state';
import type { FrameTarget } from './protocol.ts';
import { serverDir } from './registry.ts';
import { terminate } from './stim-command.ts';

export type Device = { platform: 'ios'; udid: string } | { platform: 'android'; serial: string };

export interface Frame {
  width: number;
  height: number;
  capturedAt: string;
  data: string;
}

export interface FrameListener {
  frame: (frame: Frame) => void;
  failed: (message: string) => void;
}

const MIN_INTERVAL_MS = 200;
const MAX_INTERVAL_MS = 1000;
const MAX_CAPTURES = 2;
const TOOL_TIMEOUT_MS = 10_000;
const MAX_EDGE = 1280;
const JPEG_QUALITY = 70;

export function deviceKey(device: Device): string {
  return device.platform === 'ios' ? `ios:${device.udid}` : `android:${device.serial}`;
}

export function ownedDevice(payload: StatusPayload, target: FrameTarget, attached: string | null): Device | string {
  const slot = target.slot ?? 'default';
  if (!Array.isArray(payload.environments)) return 'stim status printed a payload without environments.';
  const environment = payload.environments.find((candidate) => candidate.path === target.workspace);
  if (!environment) return `${target.workspace} is not a Stim workspace on this Mac.`;
  const devices =
    slot === 'default'
      ? { ios: environment.ios, android: environment.android }
      : environment.slots?.find((candidate) => candidate.slot === slot);
  const where = `${target.platform} in slot ${slot} of ${target.workspace}`;
  if (target.platform === 'ios') {
    const sim = devices?.ios;
    if (!sim?.owned) return `No simulator Stim owns runs ${where}.`;
    if (sim.state !== 'Booted') return `The simulator for ${where} is ${sim.state}, not booted.`;
    return { platform: 'ios', udid: sim.udid };
  }
  const emulator = devices?.android;
  if (!emulator?.owned || emulator.physical) return `No emulator Stim owns runs ${where}.`;
  if (!emulator.serial) return `The emulator for ${where} is not running.`;
  const device: Device = { platform: 'android', serial: emulator.serial };
  const stillAttached = emulator.state === 'unknown' && attached === deviceKey(device);
  if (emulator.state !== 'detected' && !stillAttached) return `The emulator for ${where} is not running.`;
  return device;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

function runTool(file: string, args: string[], env: NodeJS.ProcessEnv, running: Set<ChildProcess>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    child.once('close', () => running.delete(child));
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      void terminate(child);
      reject(new Error(`${file} ${args[0]} did not finish within ${TOOL_TIMEOUT_MS / 1000} s.`));
    }, TOOL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-1000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${file} could not start (${error.message}).`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else
        reject(
          Object.assign(new Error(`${file} ${args.join(' ')} exited (code ${code}): ${stderr.trim()}`), { stderr }),
        );
    });
  });
}

interface Capture {
  raw: Buffer;
  jpeg: () => Promise<Buffer>;
}

interface Capturer {
  capture: () => Promise<Capture>;
  close: () => Promise<void>;
}

async function stopTools(running: Set<ChildProcess>, tmp: string | null): Promise<void> {
  await Promise.all([...running].map((child) => terminate(child)));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

/**
 * Without `--display`, simctl captures the first panel it finds, which on a foldable simulator (iPhone Duo)
 * can be the unlit one and comes back black; `primary` is the panel CoreDevice reports as primary. A simctl
 * that rejects `primary` gets the default display instead.
 */
function simulatorCapturer(udid: string, env: NodeJS.ProcessEnv): Capturer {
  let tmp: string | null = null;
  let display: string[] = ['--display=primary'];
  const running = new Set<ChildProcess>();
  const screenshot = (output: string) =>
    runTool('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', ...display, output], env, running);
  return {
    capture: async () => {
      tmp ??= mkdtempSync(join(serverDir(), 'frames-'));
      const output = join(tmp, 'frame.jpg');
      try {
        await screenshot(output);
      } catch (error) {
        if (!display.length || !/display/i.test((error as { stderr?: string }).stderr ?? '')) throw error;
        display = [];
        await screenshot(output);
      }
      const jpeg = readFileSync(output);
      return { raw: jpeg, jpeg: async () => jpeg };
    },
    close: () => stopTools(running, tmp),
  };
}

interface EmulatorEndpoint {
  grpcPort: number;
  token: string | null;
}

/**
 * The emulator writes `pid_<pid>.ini` to this directory on macOS when it was started with `-grpc`, which
 * Stim passes when it boots an owned AVD (#1064).
 */
function emulatorEndpoint(env: NodeJS.ProcessEnv, serial: string): EmulatorEndpoint | null {
  const console = /^emulator-(\d+)$/.exec(serial)?.[1];
  if (!console || !env.HOME) return null;
  const dir = join(env.HOME, 'Library/Caches/TemporaryItems/avd/running');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const pid = /^pid_(\d+)\.ini$/.exec(name)?.[1];
    if (!pid) continue;
    try {
      process.kill(Number(pid), 0);
    } catch {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const values = new Map(
      text.split(/\r?\n/).flatMap((line) => {
        const at = line.indexOf('=');
        return at > 0 ? [[line.slice(0, at), line.slice(at + 1)] as const] : [];
      }),
    );
    const grpcPort = Number(values.get('grpc.port'));
    if (values.get('port.serial') === console && Number.isInteger(grpcPort) && grpcPort > 0) {
      return { grpcPort, token: values.get('grpc.token') ?? null };
    }
  }
  return null;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

type ProtoField = { field: number; varint: number } | { field: number; bytes: Buffer };

function* protoFields(bytes: Buffer): Generator<ProtoField> {
  let offset = 0;
  const readVarint = () => {
    let result = 0;
    let scale = 1;
    for (;;) {
      if (offset >= bytes.length) throw new Error('truncated protobuf');
      const byte = bytes[offset++]!;
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) return result;
      scale *= 128;
    }
  };
  while (offset < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const type = key % 8;
    if (type === 0) yield { field, varint: readVarint() };
    else if (type === 2) {
      const length = readVarint();
      if (offset + length > bytes.length) throw new Error('truncated protobuf');
      yield { field, bytes: bytes.subarray(offset, offset + length) };
      offset += length;
    } else if (type === 1) offset += 8;
    else if (type === 5) offset += 4;
    else throw new Error(`unsupported protobuf wire type ${type}`);
  }
}

/** `ImageFormat` and `Image` in the emulator's emulator_controller.proto; format 0 is PNG. */
function screenshotRequest(): Buffer {
  const message = Buffer.from([3 << 3, ...varint(MAX_EDGE), 4 << 3, ...varint(MAX_EDGE)]);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function screenshotImage(body: Buffer): Buffer {
  if (body.length < 5 || body[0] !== 0) throw new Error('getScreenshot returned no message.');
  const message = body.subarray(5, 5 + body.readUInt32BE(1));
  for (const entry of protoFields(message)) {
    if (entry.field === 4 && 'bytes' in entry) return Buffer.from(entry.bytes);
  }
  throw new Error('getScreenshot returned no image.');
}

function emulatorCapturer(serial: string, env: NodeJS.ProcessEnv): Capturer {
  let session: ClientHttp2Session | null = null;
  let tmp: string | null = null;
  const running = new Set<ChildProcess>();
  const call = (endpoint: EmulatorEndpoint) =>
    new Promise<Buffer>((resolve, reject) => {
      if (!session || session.closed || session.destroyed) {
        session = connect(`http://127.0.0.1:${endpoint.grpcPort}`);
        session.on('error', () => {});
      }
      const request = session.request({
        ':method': 'POST',
        ':path': '/android.emulation.control.EmulatorController/getScreenshot',
        'content-type': 'application/grpc',
        te: 'trailers',
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
      });
      const chunks: Buffer[] = [];
      let status: string | undefined;
      let message: string | undefined;
      const record = (headers: Record<string, unknown>) => {
        if (headers['grpc-status'] !== undefined) status = String(headers['grpc-status']);
        if (headers['grpc-message'] !== undefined) message = String(headers['grpc-message']);
      };
      request.setTimeout(TOOL_TIMEOUT_MS, () => request.close());
      request.on('response', record);
      request.on('trailers', record);
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('error', (error) => reject(new Error(`getScreenshot failed on ${serial}: ${error.message}`)));
      request.on('close', () => {
        if (status === '0') return resolve(Buffer.concat(chunks));
        reject(new Error(`getScreenshot failed on ${serial}: ${message ?? `status ${status ?? 'missing'}`}`));
      });
      request.end(screenshotRequest());
    });
  return {
    capture: async () => {
      const endpoint = emulatorEndpoint(env, serial);
      if (!endpoint) {
        throw new Error(`${serial} has no gRPC endpoint. Frames appear after Stim next boots this emulator.`);
      }
      const png = screenshotImage(await call(endpoint));
      return {
        raw: png,
        jpeg: async () => {
          tmp ??= mkdtempSync(join(serverDir(), 'frames-'));
          const input = join(tmp, 'frame.png');
          const output = join(tmp, 'frame.jpg');
          writeFileSync(input, png);
          const format = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY)];
          await runTool('sips', [...format, input, '--out', output], env, running);
          return readFileSync(output);
        },
      };
    },
    close: () => {
      session?.close();
      return stopTools(running, tmp);
    },
  };
}

class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

class FrameSource {
  private readonly listeners = new Set<FrameListener>();
  private last: Frame | null = null;
  private lastHash: string | null = null;
  private interval = MIN_INTERVAL_MS;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly capturer: Capturer;
  private readonly limiter: Limiter;
  private readonly ended: () => void;

  constructor(capturer: Capturer, limiter: Limiter, ended: () => void) {
    this.capturer = capturer;
    this.limiter = limiter;
    this.ended = ended;
    void this.tick();
  }

  add(listener: FrameListener): () => void {
    this.listeners.add(listener);
    if (this.last) listener.frame(this.last);
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) void this.stop();
    };
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
    this.ended();
    return this.capturer.close();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    let took = 0;
    try {
      const changed = await this.limiter.run(async () => {
        if (this.stopped) return false;
        const started = Date.now();
        const capture = await this.capturer.capture();
        const hash = createHash('sha256').update(capture.raw).digest('hex');
        took = Date.now() - started;
        if (hash === this.lastHash || this.stopped) return false;
        const jpeg = await capture.jpeg();
        const size = jpegSize(jpeg);
        if (!size) throw new Error('The screenshot is not a JPEG image.');
        this.lastHash = hash;
        this.last = { ...size, capturedAt: new Date(started).toISOString(), data: jpeg.toString('base64') };
        took = Date.now() - started;
        return true;
      });
      if (this.stopped) return;
      if (changed) for (const listener of this.listeners) listener.frame(this.last!);
      this.interval = changed ? MIN_INTERVAL_MS : Math.min(this.interval * 2, MAX_INTERVAL_MS);
      this.timer = setTimeout(() => void this.tick(), Math.max(this.interval - took, took));
    } catch (error) {
      if (this.stopped) return;
      const listeners = [...this.listeners];
      void this.stop();
      for (const listener of listeners) listener.failed((error as Error).message);
    }
  }
}

/**
 * One capture loop per device, shared by its subscribers and stopped with the last of them. A loop sends a
 * frame only when the screen changed; it captures up to 5 times a second while the screen changes and backs
 * off to once a second while it does not, and spends at most half of its time capturing. At most two
 * captures run at once across all devices.
 */
export class FramePool {
  private readonly sources = new Map<string, FrameSource>();
  private readonly limiter = new Limiter(MAX_CAPTURES);
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
  }

  subscribe(device: Device, listener: FrameListener): () => void {
    const key = deviceKey(device);
    let source = this.sources.get(key);
    if (!source) {
      const capturer =
        device.platform === 'ios'
          ? simulatorCapturer(device.udid, this.env)
          : emulatorCapturer(device.serial, this.env);
      const created: FrameSource = new FrameSource(capturer, this.limiter, () => {
        if (this.sources.get(key) === created) this.sources.delete(key);
      });
      this.sources.set(key, created);
      source = created;
    }
    return source.add(listener);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sources.values()].map((source) => source.stop()));
  }
}
