import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import { isJsonObject } from '@stim-cli/core/state';
import type { FeedListener, JsonObject } from './feed.ts';

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;
const STOP_GRACE_MS = 2_000;

/**
 * A status worker to start on another thread: the entry, its environment and directory, and the port it reads `stop`
 * from and posts its payloads on. After `stop` it posts `{ stopped: true }` once its children have ended, before its
 * file watchers close.
 */
export interface StatusWorkerRequest {
  worker: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  port: MessagePort;
}

interface StatusFeedOptions {
  worker: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /**
   * Starts the worker on another thread instead of as a child of this one. A thread cannot exit until its child
   * workers have closed their FSEvents watches, which can take seconds each while fseventsd is busy.
   */
  spawn?: (request: StatusWorkerRequest) => void;
}

/**
 * The status of this server's Stim home, read by the status watch in a worker thread: the latest payload goes to every
 * listener, and a new listener gets it at once. The worker runs while anyone listens or the feed is held. When it
 * fails, every listener is told and dropped; a held feed starts it again after a delay that doubles up to a minute
 * and resets once a payload arrives.
 */
export class StatusFeed {
  private readonly listeners = new Set<FeedListener>();
  private worker: Worker | MessagePort | null = null;
  private latest: { value: JsonObject; text: string } | null = null;
  private held = false;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private delay = RESTART_MIN_MS;
  private readonly stopping = new Set<Promise<unknown>>();
  private readonly options: StatusFeedOptions;

  constructor(options: StatusFeedOptions) {
    this.options = options;
  }

  /** Keeps the worker running with no listener, so the first one gets a payload at once. */
  hold(): void {
    this.held = true;
    this.start();
  }

  subscribe(listener: FeedListener): () => void {
    this.listeners.add(listener);
    if (this.restart) {
      clearTimeout(this.restart);
      this.restart = null;
    }
    this.start();
    if (this.latest) listener.item(this.latest.value, this.latest.text);
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0 && !this.held) this.stop();
    };
  }

  async close(): Promise<void> {
    this.held = false;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    this.listeners.clear();
    this.stop();
    await Promise.all(this.stopping);
  }

  private start(): void {
    if (this.worker || this.restart) return;
    const { worker: entry, env, cwd, spawn } = this.options;
    if (spawn) {
      const { port1, port2 } = new MessageChannel();
      this.worker = port1;
      port1.on('message', (message: unknown) => this.received(port1, message));
      port1.on('close', () => this.ended(port1, 'the status worker exited'));
      spawn({ worker: entry, env, cwd, port: port2 });
      return;
    }
    const worker = new Worker(entry, { env, workerData: { cwd } });
    this.worker = worker;
    worker.on('message', (message: unknown) => this.received(worker, message));
    worker.on('error', (error: Error) => this.ended(worker, `the status worker failed (${error.message})`));
    worker.on('exit', (code) => this.ended(worker, `the status worker exited (code ${code})`));
  }

  private received(worker: Worker | MessagePort, message: unknown): void {
    if (this.worker !== worker || !isJsonObject(message)) return;
    if (typeof message.failed === 'string') {
      process.stderr.write(`stim status: ${message.failed}\n`);
      return;
    }
    if (typeof message.line !== 'string') return;
    let value: unknown;
    try {
      value = JSON.parse(message.line);
    } catch {
      return;
    }
    if (!isJsonObject(value)) return;
    this.delay = RESTART_MIN_MS;
    this.latest = { value, text: message.line };
    for (const listener of this.listeners) listener.item(value, message.line);
  }

  /**
   * Asks the worker to stop its watch, which ends the adb and simctl children it started. A child worker counts as
   * stopped once it exits, and is terminated if it has not exited after a grace period. A worker started through
   * `spawn` counts as stopped once it posts `{ stopped: true }` or its port closes; the caller's own stop limit bounds
   * that wait, since this thread cannot terminate it.
   */
  private stop(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.latest = null;
    const stopped = new Promise<void>((resolve) => {
      if (worker instanceof Worker) {
        const grace = setTimeout(() => void worker.terminate(), STOP_GRACE_MS);
        worker.once('exit', () => {
          clearTimeout(grace);
          resolve();
        });
        worker.postMessage('stop');
      } else {
        worker.on('message', (message: unknown) => {
          if (isJsonObject(message) && message.stopped === true) worker.close();
        });
        worker.once('close', resolve);
        worker.postMessage('stop');
      }
    }).finally(() => this.stopping.delete(stopped));
    this.stopping.add(stopped);
  }

  private ended(worker: Worker | MessagePort, message: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.latest = null;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener.failed(message);
    if (!this.held) return;
    this.restart = setTimeout(() => {
      this.restart = null;
      if (this.held) this.start();
    }, this.delay);
    this.restart.unref();
    this.delay = Math.min(this.delay * 2, RESTART_MAX_MS);
  }
}
