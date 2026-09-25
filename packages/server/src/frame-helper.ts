import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Device, Frame, FrameListener } from './frames.ts';
import { FRAME_EDGE, FRAME_FPS } from './protocol.ts';
import { serverDir } from './registry.ts';
import { terminate } from './stim-command.ts';

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

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      void terminate(child);
      reject(new Error(`${file} ${args[0]} did not finish within ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output = (output + chunk).slice(-4000)));
    child.stderr.on('data', (chunk: string) => (output = (output + chunk).slice(-4000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${file} could not start (${error.message}).`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${file} ${args[0]} exited (code ${code}): ${output.trim()}`));
    });
  });
}

/**
 * Compiles the `stim-frames` helper from the Swift sources shipped in `dist/stim-frames/` into
 * `$STIM_HOME/server/helpers/`, named by a hash of the sources and the compiler version, and removes helpers
 * built from other sources. Resolves to the helper's path, or rejects with the reason it cannot be built.
 */
export async function buildFrameHelper(env: NodeJS.ProcessEnv, sourcesDir: string = SOURCES_DIR): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('stim-frames runs only on macOS.');
  const sources = readdirSync(sourcesDir)
    .filter((name) => name.endsWith('.swift'))
    .toSorted();
  if (!sources.length) throw new Error(`${sourcesDir} has no Swift sources.`);
  const version = await run('xcrun', ['swiftc', '--version'], env, VERSION_TIMEOUT_MS);
  const hash = createHash('sha256').update(version);
  for (const name of sources) hash.update(name).update(readFileSync(join(sourcesDir, name)));
  const dir = join(serverDir(), 'helpers');
  const name = `stim-frames-${hash.digest('hex').slice(0, 16)}`;
  const helper = join(dir, name);
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
    );
    renameSync(output, helper);
  } finally {
    rmSync(output, { force: true });
  }
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('stim-frames-') && entry !== name) rmSync(join(dir, entry), { force: true });
  }
  return helper;
}

/**
 * One `stim-frames` process per device, shared by its subscribers and stopped with the last of them. It runs
 * at the highest fps and the largest edge any subscriber asked for; each subscriber paces its own frames. The
 * helper exits when its stdin closes, so it cannot outlive the server.
 */
export class HelperSource {
  private readonly listeners = new Map<FrameListener, FrameHint>();
  private readonly child: ChildProcess;
  private last: Frame | null = null;
  private config = '';
  private stopped = false;
  private notice: string | null = null;
  private stderr = '';
  private readonly ended: () => void;

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

  add(listener: FrameListener, hint: FrameHint): () => void {
    this.listeners.set(listener, hint);
    this.configure();
    if (this.last) listener.frame(this.last);
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) void this.stop();
      else this.configure();
    };
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.listeners.clear();
    this.ended();
    this.child.stdin!.end();
    return terminate(this.child);
  }

  private configure(): void {
    const hints = [...this.listeners.values()];
    const config = JSON.stringify({
      fps: Math.max(...hints.map((hint) => hint.fps)),
      maxEdge: Math.max(...hints.map((hint) => hint.maxEdge)),
    });
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
        if (length < 1 || length > MAX_MESSAGE_BYTES) return this.fail(`stim-frames wrote a malformed message.`);
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        if (body[0] === FRAME_MESSAGE && body.length > 5) this.frame(body);
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
    for (const listener of this.listeners.keys()) listener.frame(this.last);
  }

  private readNotice(text: string): void {
    try {
      const notice: unknown = JSON.parse(text);
      const error = (notice as { error?: unknown } | null)?.error;
      if (typeof error === 'string') this.notice = error;
    } catch {}
  }
}
