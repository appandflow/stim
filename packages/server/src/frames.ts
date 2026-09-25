import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type ClientHttp2Session } from 'node:http2';
import { join } from 'node:path';
import type { StatusPayload } from '@stim-cli/core/state';
import type { FrameTarget } from './protocol.ts';
import { serverDir } from './registry.ts';
import { DEFAULT_FRAME_HINT, HelperSource, type FrameHint } from './frame-helper.ts';
import { terminate } from './stim-command.ts';
import type { AccessUnit } from './video.ts';

/** `foldable` marks an iPhone Duo, whose posture lights one of two panels. */
export type Device = { platform: 'ios'; udid: string; foldable: boolean } | { platform: 'android'; serial: string };

type Posture = 'folded' | 'unfolded';

export interface Frame {
  width: number;
  height: number;
  capturedAt: string;
  data: string;
  posture?: Posture;
}

export interface FrameListener {
  frame: (frame: Frame) => void;
  /**
   * With `video`, a device the helper streams sends H.264 access units here instead of JPEG frames; a device on
   * screenshots still sends `frame`.
   */
  video?: (unit: AccessUnit) => void;
  /** A capture is taking longer than usual, or a timed-out capture is being retried; the last frame stays valid. */
  delayed: (delayed: boolean) => void;
  failed: (message: string) => void;
}

/** Tunables for capture timing; a busy Mac makes `xcrun simctl` and the emulator's gRPC call slow, not broken. */
export interface FrameLimits {
  /** Per-capture timeout for `simctl`, `sips`, and the emulator's gRPC call. */
  toolTimeoutMs: number;
  /** A capture slower than this is reported as delayed, even when it succeeds. */
  slowCaptureMs: number;
  /** Wait before retrying after a timed-out capture. */
  failureBackoffMs: number;
  /** Consecutive timed-out captures before the subscription ends with `frames-failed`. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_FRAME_LIMITS: FrameLimits = {
  toolTimeoutMs: 30_000,
  slowCaptureMs: 3_000,
  failureBackoffMs: 3_000,
  maxConsecutiveFailures: 3,
};

const MIN_INTERVAL_MS = 200;
const MAX_INTERVAL_MS = 1000;
const MAX_CAPTURES = 2;
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
    return { platform: 'ios', udid: sim.udid, foldable: /\bDuo\b/.test(sim.name ?? '') };
  }
  const emulator = devices?.android;
  if (!emulator?.owned || emulator.physical) return `No emulator Stim owns runs ${where}.`;
  if (emulator.state === 'unknown' && attached?.startsWith('android:')) {
    return { platform: 'android', serial: attached.slice('android:'.length) };
  }
  if (emulator.state !== 'detected' || !emulator.serial) return `The emulator for ${where} is not running.`;
  return { platform: 'android', serial: emulator.serial };
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

/** A rejection with `transient: true` is a timeout on a machine that is merely busy, not a broken capturer. */
function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { transient: true });
}

function isTransient(error: unknown): boolean {
  return error instanceof Error && (error as { transient?: boolean }).transient === true;
}

function runTool(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  running: Set<ChildProcess>,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    child.once('close', () => running.delete(child));
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      void terminate(child);
      reject(timeoutError(`${file} ${args[0]} did not finish within ${timeoutMs / 1000} s.`));
    }, timeoutMs);
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
  posture?: Posture;
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
 * Without `--display`, simctl captures the first panel it finds; `primary` is the panel CoreDevice reports as
 * primary. A simctl that rejects `primary` gets the default display instead.
 *
 * An iPhone Duo lights one of two panels: `primary` is the cover, lit when folded, and `primary-1` the inner
 * panel, lit when unfolded; the other one's framebuffer is all black. `litPanels` remembers the lit panel per
 * simulator across subscriptions, and a black capture tries the other panel.
 */
function simulatorCapturer(
  device: { udid: string; foldable: boolean },
  env: NodeJS.ProcessEnv,
  limits: FrameLimits,
  litPanels: Map<string, DuoPanel>,
): Capturer {
  let tmp: string | null = null;
  let display: string[] = ['--display=primary'];
  let closed = false;
  const running = new Set<ChildProcess>();
  const screenshot = async (panel: string[]): Promise<Buffer> => {
    tmp ??= mkdtempSync(join(serverDir(), 'frames-'));
    const output = join(tmp, 'frame.jpg');
    await runTool(
      'xcrun',
      ['simctl', 'io', device.udid, 'screenshot', '--type=jpeg', ...panel, output],
      env,
      running,
      limits.toolTimeoutMs,
    );
    return readFileSync(output);
  };
  const isBlack = async (jpeg: Buffer): Promise<boolean> => {
    const input = join(tmp!, 'check.jpg');
    const output = join(tmp!, 'check.bmp');
    writeFileSync(input, jpeg);
    await runTool(
      'sips',
      ['-s', 'format', 'bmp', '-z', '24', '24', input, '--out', output],
      env,
      running,
      limits.toolTimeoutMs,
    );
    return bmpIsBlack(readFileSync(output));
  };
  const open = () => {
    if (closed) throw new Error('The capture was stopped.');
  };
  const captureDuo = async (): Promise<Capture> => {
    const lit = litPanels.get(device.udid) ?? 'primary';
    const jpeg = await screenshot([`--display=${lit}`]);
    open();
    if (!(await isBlack(jpeg))) return { raw: jpeg, jpeg: async () => jpeg, posture: POSTURES[lit] };
    const other: DuoPanel = lit === 'primary' ? 'primary-1' : 'primary';
    open();
    const otherJpeg = await screenshot([`--display=${other}`]);
    open();
    if (await isBlack(otherJpeg)) return { raw: jpeg, jpeg: async () => jpeg };
    litPanels.set(device.udid, other);
    return { raw: otherJpeg, jpeg: async () => otherJpeg, posture: POSTURES[other] };
  };
  return {
    capture: async () => {
      if (device.foldable) return captureDuo();
      let jpeg: Buffer;
      try {
        jpeg = await screenshot(display);
      } catch (error) {
        if (closed || !display.length || !/display/i.test((error as { stderr?: string }).stderr ?? '')) throw error;
        display = [];
        jpeg = await screenshot(display);
      }
      return { raw: jpeg, jpeg: async () => jpeg };
    },
    close: () => {
      closed = true;
      return stopTools(running, tmp);
    },
  };
}

type DuoPanel = 'primary' | 'primary-1';

const POSTURES: Record<DuoPanel, Posture> = { primary: 'folded', 'primary-1': 'unfolded' };

/** Whether every pixel of an uncompressed 24- or 32-bit BMP, as `sips -s format bmp` writes it, is black. */
function bmpIsBlack(bmp: Buffer): boolean {
  if (bmp.length < 54 || bmp.toString('latin1', 0, 2) !== 'BM') throw new Error('sips did not write a BMP image.');
  const offset = bmp.readUInt32LE(10);
  const bytesPerPixel = bmp.readUInt16LE(28) / 8;
  for (let at = offset; at + 3 <= bmp.length; at += bytesPerPixel) {
    if (bmp[at]! > 8 || bmp[at + 1]! > 8 || bmp[at + 2]! > 8) return false;
  }
  return true;
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

function grpcMessage(message: number[]): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, Buffer.from(message)]);
}

function grpcReply(body: Buffer, method: string): Buffer {
  if (body.length < 5 || body[0] !== 0) throw new Error(`${method} returned no message.`);
  return body.subarray(5, 5 + body.readUInt32BE(1));
}

/**
 * `ImageFormat` and `Image` in the emulator's emulator_controller.proto; format 0 is PNG. The reply's
 * format carries `foldedDisplay` (field 7) while a foldable is folded.
 */
function screenshotReply(body: Buffer): { png: Buffer; folded: boolean } {
  let png: Buffer | null = null;
  let folded = false;
  for (const entry of protoFields(grpcReply(body, 'getScreenshot'))) {
    if (entry.field === 4 && 'bytes' in entry) png = Buffer.from(entry.bytes);
    if (entry.field === 1 && 'bytes' in entry) {
      folded = [...protoFields(entry.bytes)].some((format) => format.field === 7);
    }
  }
  if (!png) throw new Error('getScreenshot returned no image.');
  return { png, folded };
}

/**
 * `PhysicalModelValue` for POSTURE (PhysicalType 16), whose one float is a `Posture.PostureValue`; 1 to 5
 * are real postures, so any of them means the emulator has a hinge.
 */
function hasHinge(body: Buffer): boolean {
  for (const entry of protoFields(grpcReply(body, 'getPhysicalModel'))) {
    if (entry.field === 2 && 'varint' in entry && entry.varint !== 0) return false;
    if (entry.field !== 3 || !('bytes' in entry)) continue;
    for (const value of protoFields(entry.bytes)) {
      if (value.field !== 1 || !('bytes' in value) || value.bytes.length < 4) continue;
      const posture = Math.round(value.bytes.readFloatLE(0));
      return posture >= 1 && posture <= 5;
    }
  }
  return false;
}

function emulatorCapturer(serial: string, env: NodeJS.ProcessEnv, limits: FrameLimits): Capturer {
  let session: ClientHttp2Session | null = null;
  let tmp: string | null = null;
  const running = new Set<ChildProcess>();
  let hinged: boolean | null = null;
  const call = (endpoint: EmulatorEndpoint, method: string, requestBody: Buffer) =>
    new Promise<Buffer>((resolve, reject) => {
      if (!session || session.closed || session.destroyed) {
        session = connect(`http://127.0.0.1:${endpoint.grpcPort}`);
        session.on('error', () => {});
      }
      const request = session.request({
        ':method': 'POST',
        ':path': `/android.emulation.control.EmulatorController/${method}`,
        'content-type': 'application/grpc',
        te: 'trailers',
        ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
      });
      const chunks: Buffer[] = [];
      let status: string | undefined;
      let message: string | undefined;
      let timedOut = false;
      const record = (headers: Record<string, unknown>) => {
        if (headers['grpc-status'] !== undefined) status = String(headers['grpc-status']);
        if (headers['grpc-message'] !== undefined) message = String(headers['grpc-message']);
      };
      request.setTimeout(limits.toolTimeoutMs, () => {
        timedOut = true;
        request.close();
      });
      request.on('response', record);
      request.on('trailers', record);
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('error', (error) => {
        const text = `${method} failed on ${serial}: ${error.message}`;
        reject(timedOut ? timeoutError(text) : new Error(text));
      });
      request.on('close', () => {
        if (status === '0') return resolve(Buffer.concat(chunks));
        const text = `${method} failed on ${serial}: ${message ?? `status ${status ?? 'missing'}`}`;
        reject(timedOut ? timeoutError(text) : new Error(text));
      });
      request.end(requestBody);
    });
  return {
    capture: async () => {
      const endpoint = emulatorEndpoint(env, serial);
      if (!endpoint) {
        throw new Error(`${serial} has no gRPC endpoint. Frames appear after Stim next boots this emulator.`);
      }
      hinged ??= await call(endpoint, 'getPhysicalModel', grpcMessage([1 << 3, 16])).then(hasHinge, () => false);
      const { png, folded } = screenshotReply(
        await call(endpoint, 'getScreenshot', grpcMessage([3 << 3, ...varint(MAX_EDGE), 4 << 3, ...varint(MAX_EDGE)])),
      );
      return {
        raw: png,
        ...(hinged ? { posture: folded ? ('folded' as const) : ('unfolded' as const) } : {}),
        jpeg: async () => {
          tmp ??= mkdtempSync(join(serverDir(), 'frames-'));
          const input = join(tmp, 'frame.png');
          const output = join(tmp, 'frame.jpg');
          writeFileSync(input, png);
          const format = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY)];
          await runTool('sips', [...format, input, '--out', output], env, running, limits.toolTimeoutMs);
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
  private delayed = false;
  private consecutiveFailures = 0;

  private readonly capturer: Capturer;
  private readonly limiter: Limiter;
  private readonly limits: FrameLimits;
  private readonly ended: () => void;

  constructor(capturer: Capturer, limiter: Limiter, limits: FrameLimits, ended: () => void) {
    this.capturer = capturer;
    this.limiter = limiter;
    this.limits = limits;
    this.ended = ended;
    void this.tick();
  }

  add(listener: FrameListener): () => void {
    this.listeners.add(listener);
    if (this.last) listener.frame(this.last);
    if (this.delayed) listener.delayed(true);
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

  private setDelayed(delayed: boolean): void {
    if (this.delayed === delayed) return;
    this.delayed = delayed;
    for (const listener of this.listeners) listener.delayed(delayed);
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
        this.last = {
          ...size,
          capturedAt: new Date(started).toISOString(),
          data: jpeg.toString('base64'),
          ...(capture.posture ? { posture: capture.posture } : {}),
        };
        took = Date.now() - started;
        return true;
      });
      if (this.stopped) return;
      this.consecutiveFailures = 0;
      this.setDelayed(took > this.limits.slowCaptureMs);
      if (changed) for (const listener of this.listeners) listener.frame(this.last!);
      this.interval = changed ? MIN_INTERVAL_MS : Math.min(this.interval * 2, MAX_INTERVAL_MS);
      this.timer = setTimeout(() => void this.tick(), Math.max(this.interval - took, took));
    } catch (error) {
      if (this.stopped) return;
      if (isTransient(error) && this.consecutiveFailures + 1 < this.limits.maxConsecutiveFailures) {
        this.consecutiveFailures++;
        this.setDelayed(true);
        this.timer = setTimeout(() => void this.tick(), this.limits.failureBackoffMs);
        return;
      }
      const listeners = [...this.listeners];
      void this.stop();
      for (const listener of listeners) listener.failed((error as Error).message);
    }
  }
}

/**
 * One capture per device, shared by its subscribers and stopped with the last of them. With the `stim-frames`
 * helper, a device streams frames as its screen changes, at the rate its subscribers ask for. Without it, for
 * an iPhone Duo, and while the helper is still being built, a screenshot loop sends a frame only when the
 * screen changed: up to 5 times a second while it changes, backing off to once a second while it does not,
 * spending at most half of its time capturing, with at most two captures at once across all devices. A helper
 * that fails before its first frame gives way to the screenshot loop.
 */
export class FramePool {
  private readonly sources = new Map<string, FrameSource | HelperSource>();
  private readonly limiter = new Limiter(MAX_CAPTURES);
  private readonly litPanels = new Map<string, DuoPanel>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly limits: FrameLimits;
  private readonly helper: () => string | null;

  constructor(
    env: NodeJS.ProcessEnv,
    limits: FrameLimits = DEFAULT_FRAME_LIMITS,
    helper: () => string | null = () => null,
  ) {
    this.env = env;
    this.limits = limits;
    this.helper = helper;
  }

  subscribe(device: Device, listener: FrameListener, hint: FrameHint = DEFAULT_FRAME_HINT): () => void {
    const helper = this.helper();
    if (helper === null || (device.platform === 'ios' && device.foldable)) {
      return this.screenshots(device).add(listener);
    }
    let streamed = false;
    let cancelled = false;
    const { video } = listener;
    let detach = this.stream(helper, device).add(
      {
        frame: (frame) => {
          streamed = true;
          listener.frame(frame);
        },
        ...(video
          ? {
              video: (unit: AccessUnit) => {
                streamed = true;
                video(unit);
              },
            }
          : {}),
        delayed: listener.delayed,
        failed: (message) => {
          if (streamed || cancelled) return listener.failed(message);
          console.error(`stim-server: ${message} Falling back to screenshots.`);
          detach = this.screenshots(device).add(listener);
        },
      },
      hint,
    );
    return () => {
      cancelled = true;
      detach();
    };
  }

  /** Makes the next video frame of `device` a keyframe, for a subscriber whose decoder lost its state. */
  keyframe(device: Device): void {
    this.helperSource(device)?.keyframe();
  }

  /** A subscriber of `device` is behind; called until its socket drains, it lowers the shared bitrate. */
  congested(device: Device): void {
    this.helperSource(device)?.congested();
  }

  private helperSource(device: Device): HelperSource | null {
    const source = this.sources.get(`helper:${deviceKey(device)}`);
    return source instanceof HelperSource ? source : null;
  }

  private stream(helper: string, device: Device): HelperSource {
    const key = `helper:${deviceKey(device)}`;
    const existing = this.sources.get(key);
    if (existing instanceof HelperSource) return existing;
    const created: HelperSource = new HelperSource(helper, device, this.env, () => {
      if (this.sources.get(key) === created) this.sources.delete(key);
    });
    this.sources.set(key, created);
    return created;
  }

  private screenshots(device: Device): FrameSource {
    const key = deviceKey(device);
    const existing = this.sources.get(key);
    if (existing instanceof FrameSource) return existing;
    const capturer =
      device.platform === 'ios'
        ? simulatorCapturer(device, this.env, this.limits, this.litPanels)
        : emulatorCapturer(device.serial, this.env, this.limits);
    const created: FrameSource = new FrameSource(capturer, this.limiter, this.limits, () => {
      if (this.sources.get(key) === created) this.sources.delete(key);
    });
    this.sources.set(key, created);
    return created;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sources.values()].map((source) => source.stop()));
  }
}
