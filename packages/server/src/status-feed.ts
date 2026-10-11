import { Worker } from 'node:worker_threads';
import { isJsonObject } from '@stim-cli/core/state';
import type { FeedListener, JsonObject } from './feed.ts';

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;

/**
 * The status of this server's Stim home, read by the status watch in a worker thread: the latest payload goes to every
 * listener, and a new listener gets it at once. The worker runs while anyone listens or the feed is held. When it
 * fails, every listener is told and dropped; a held feed starts it again after a delay that doubles up to a minute
 * and resets once a payload arrives.
 */
export class StatusFeed {
  private readonly listeners = new Set<FeedListener>();
  private worker: Worker | null = null;
  private latest: { value: JsonObject; text: string } | null = null;
  private held = false;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private delay = RESTART_MIN_MS;
  private readonly stopping = new Set<Promise<unknown>>();
  private readonly options: { worker: string; env: NodeJS.ProcessEnv; cwd: string };

  constructor(options: { worker: string; env: NodeJS.ProcessEnv; cwd: string }) {
    this.options = options;
  }

  /** Keeps the worker running with no listener, so the first one gets a payload at once. */
  hold(): void {
    this.held = true;
    this.start();
  }

  subscribe(listener: FeedListener): () => void {
    this.listeners.add(listener);
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
    const worker = new Worker(this.options.worker, { env: this.options.env, workerData: { cwd: this.options.cwd } });
    this.worker = worker;
    worker.on('message', (message: unknown) => {
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
    });
    worker.on('error', (error: Error) => this.ended(worker, `the status worker failed (${error.message})`));
    worker.on('exit', (code) => this.ended(worker, `the status worker exited (code ${code})`));
  }

  private stop(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.latest = null;
    const stopped = worker.terminate().finally(() => this.stopping.delete(stopped));
    this.stopping.add(stopped);
  }

  private ended(worker: Worker, message: string): void {
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
