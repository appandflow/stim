import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Device, Frame, FrameListener } from './frames.ts';
import { FRAME_EDGE, FRAME_FPS } from './protocol.ts';
import { serverDir } from './registry.ts';
import { terminate } from './stim-command.ts';
import { Bitrate, DEFAULT_VIDEO_LIMITS, type AccessUnit } from './video.ts';

/** How a subscriber wants its frames: at most `fps` a second, scaled to fit `maxEdge` pixels. */
export interface FrameHint {
  fps: number;
  maxEdge: number;
}

export const DEFAULT_FRAME_HINT: FrameHint = { fps: FRAME_FPS.default, maxEdge: FRAME_EDGE.default };

const SOURCES_DIR = fileURLToPath(new URL('./stim-frames/', import.meta.url));
const BUILD_TIMEOUT_MS = 180_000;
const VERSION_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const FRAME_MESSAGE = 1;
const NOTICE_MESSAGE = 2;
const VIDEO_MESSAGE = 3;
const VIDEO_HEADER_BYTES = 14;
const KEYFRAME_INTERVAL_MS = 250;

/** Runs the compiler in its own process group, so a timeout or `signal` also stops `swift-frontend` and `ld`. */
function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let stopped: string | null = null;
    const stop = (reason: string) => {
      stopped ??= reason;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => stop(`${file} ${args[0]} did not finish within ${timeoutMs / 1000} s.`), timeoutMs);
    const abort = () => stop(`${file} ${args[0]} was stopped with the server.`);
    signal?.addEventListener('abort', abort);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output = (output + chunk).slice(-4000)));
    child.stderr.on('data', (chunk: string) => (output = (output + chunk).slice(-4000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error(`${file} could not start (${error.message}).`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (stopped) reject(new Error(stopped));
      else if (code === 0) resolve(output);
      else reject(new Error(`${file} ${args[0]} exited (code ${code}): ${output.trim()}`));
    });
  });
}

/**
 * Compiles the `stim-frames` helper from the Swift sources shipped in `dist/stim-frames/` into
 * `$STIM_HOME/server/helpers/`, named by a hash of the sources and the compiler version. Resolves to the
 * helper's path, or rejects with the reason it cannot be built.
 */
export async function buildFrameHelper(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  sourcesDir: string = SOURCES_DIR,
): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('stim-frames runs only on macOS.');
  const sources = readdirSync(sourcesDir)
    .filter((name) => name.endsWith('.swift'))
    .toSorted();
  if (!sources.length) throw new Error(`${sourcesDir} has no Swift sources.`);
  const version = await run('xcrun', ['swiftc', '--version'], env, VERSION_TIMEOUT_MS, signal);
  const hash = createHash('sha256').update(version);
  for (const name of sources) hash.update(name).update(readFileSync(join(sourcesDir, name)));
  const dir = join(serverDir(), 'helpers');
  const helper = join(dir, `stim-frames-${hash.digest('hex').slice(0, 16)}`);
  if (existsSync(helper)) return helper;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = `${helper}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await run(
      'xcrun',
      [
        'swiftc',
        '-O',
        '-swift-version',
        '5',
        '-module-name',
        'StimFrames',
        '-o',
        output,
        ...sources.map((source) => join(sourcesDir, source)),
      ],
      env,
      BUILD_TIMEOUT_MS,
      signal,
    );
    renameSync(output, helper);
  } finally {
    rmSync(output, { force: true });
  }
  return helper;
}

/**
 * One `stim-frames` process per device, shared by its subscribers and stopped with the last of them. It runs
 * at the highest fps and the largest edge any subscriber asked for; each subscriber paces its own frames. The
 * helper exits when its stdin closes, so it cannot outlive the server.
 */
export class HelperSource {
  private readonly listeners = new Map<FrameListener, FrameHint | null>();
  private readonly child: ChildProcess;
  private last: Frame | null = null;
  private config = '';
  private stopped = false;
  private notice: string | null = null;
  /** Whether the emulator reported a hardware keyboard; null until it reports. */
  keyboard: boolean | null = null;
  private stderr = '';
  private readonly ended: () => void;
  private readonly bitrate = new Bitrate(DEFAULT_VIDEO_LIMITS, Date.now());
  private keyframeAt = -Infinity;
  private keyframeTimer: NodeJS.Timeout | null = null;

  constructor(helper: string, device: Device, env: NodeJS.ProcessEnv, ended: () => void) {
    this.ended = ended;
    const id = device.platform === 'ios' ? device.udid : device.serial;
    this.child = spawn(helper, [device.platform, id], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin!.on('error', () => {});
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-1000);
    });
    this.readMessages();
    this.child.on('error', (error) => this.fail(`stim-frames could not start (${error.message}).`));
    this.child.on('close', (code, signal) => {
      const detail = this.notice ?? this.stderr.trim();
      this.fail(`stim-frames exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`);
    });
  }

  /** A null `hint` keeps the helper running for input without asking for frames. */
  add(listener: FrameListener, hint: FrameHint | null): () => void {
    this.listeners.set(listener, hint);
    this.configure();
    if (listener.video) this.keyframe();
    else if (this.last) listener.frame(this.last);
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) void this.stop();
      else this.configure();
    };
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (this.keyframeTimer) clearTimeout(this.keyframeTimer);
    this.listeners.clear();
    this.ended();
    this.child.stdin!.end();
    return terminate(this.child);
  }

  /** Asks for at most one keyframe per {@link KEYFRAME_INTERVAL_MS}; a request inside the interval is sent at its end. */
  keyframe(): void {
    if (this.stopped || this.keyframeTimer) return;
    const wait = this.keyframeAt + KEYFRAME_INTERVAL_MS - Date.now();
    if (wait > 0) {
      this.keyframeTimer = setTimeout(() => {
        this.keyframeTimer = null;
        this.keyframe();
      }, wait);
      return;
    }
    this.keyframeAt = Date.now();
    this.child.stdin!.write('{"keyframe":true}\n');
  }

  congested(): void {
    if (this.bitrate.congested(Date.now()) !== null) this.configure();
  }

  send(command: Record<string, unknown>): void {
    if (!this.stopped) this.child.stdin!.write(`${JSON.stringify(command)}\n`);
  }

  private configure(): void {
    const watching = [...this.listeners].flatMap(([listener, hint]) => (hint ? [{ listener, hint }] : []));
    const hints = watching.map(({ hint }) => hint);
    const jpegFps = watching.flatMap(({ listener, hint }) => (listener.video ? [] : [hint.fps]));
    const config = JSON.stringify({
      fps: Math.max(0, ...hints.map((hint) => hint.fps)),
      maxEdge: Math.max(FRAME_EDGE.min, ...hints.map((hint) => hint.maxEdge)),
      jpeg: jpegFps.length > 0,
      ...(jpegFps.length ? { jpegFps: Math.max(...jpegFps) } : {}),
      video: jpegFps.length < hints.length,
      bitrate: this.bitrate.current,
    });
    if (!jpegFps.length) this.last = null;
    if (config === this.config || this.stopped) return;
    this.config = config;
    this.child.stdin!.write(`${config}\n`);
  }

  private fail(message: string): void {
    if (this.stopped) return;
    const listeners = [...this.listeners.keys()];
    void this.stop();
    for (const listener of listeners) listener.failed(message);
  }

  private readMessages(): void {
    let buffer: Buffer = Buffer.alloc(0);
    this.child.stdout!.on('data', (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 1 || length > MAX_MESSAGE_BYTES) {
          this.child.stdout!.removeAllListeners('data');
          return this.fail('stim-frames wrote a malformed message.');
        }
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        if (body[0] === FRAME_MESSAGE && body.length > 5) this.frame(body);
        else if (body[0] === VIDEO_MESSAGE && body.length > VIDEO_HEADER_BYTES) this.video(body);
        else if (body[0] === NOTICE_MESSAGE) this.readNotice(body.subarray(1).toString('utf8'));
      }
    });
  }

  private frame(body: Buffer): void {
    if (this.stopped) return;
    this.last = {
      width: body.readUInt16BE(1),
      height: body.readUInt16BE(3),
      capturedAt: new Date().toISOString(),
      data: body.subarray(5).toString('base64'),
    };
    for (const listener of this.listeners.keys()) if (!listener.video) listener.frame(this.last);
  }

  private video(body: Buffer): void {
    if (this.stopped) return;
    const unit: AccessUnit = {
      keyframe: (body[1]! & 1) !== 0,
      capturedAt: body.readDoubleBE(2),
      width: body.readUInt16BE(10),
      height: body.readUInt16BE(12),
      data: body.subarray(VIDEO_HEADER_BYTES),
    };
    if (this.bitrate.tick(Date.now()) !== null) this.configure();
    for (const listener of this.listeners.keys()) listener.video?.(unit);
  }

  private readNotice(text: string): void {
    try {
      const notice: unknown = JSON.parse(text);
      const error = (notice as { error?: unknown } | null)?.error;
      if (typeof error === 'string') this.notice = error;
      const keyboard = (notice as { keyboard?: unknown } | null)?.keyboard;
      if (keyboard === 'yes' || keyboard === 'no') this.keyboard = keyboard === 'yes';
      const inputError = (notice as { inputError?: unknown } | null)?.inputError;
      if (typeof inputError === 'string') console.error(`stim-server: stim-frames: ${inputError}`);
    } catch {}
  }
}
