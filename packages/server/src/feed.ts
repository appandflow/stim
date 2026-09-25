import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isJsonObject } from '@stim-cli/core/state';
import { terminate } from './stim-command.ts';

export type JsonObject = Record<string, unknown>;

export interface FeedListener {
  item: (value: JsonObject) => void;
  failed: (message: string) => void;
}

export interface FeedSpec {
  args: string[];
  cwd: string;
  keep: number;
  label: string;
}

const STDERR_TAIL = 2000;

class Feed {
  private readonly listeners = new Set<FeedListener>();
  private readonly kept: JsonObject[] = [];
  private child: ChildProcess | null;

  private readonly ended: () => void;

  constructor(spec: FeedSpec, stimCli: string, env: NodeJS.ProcessEnv, ended: () => void) {
    this.ended = ended;
    const child = spawn(process.execPath, [stimCli, ...spec.args], {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (this.child !== child) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!isJsonObject(value)) return;
      this.kept.push(value);
      if (this.kept.length > spec.keep) this.kept.shift();
      for (const listener of this.listeners) listener.item(value);
    });
    const exited = (reason: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ended();
      const message = `${spec.label} ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
      const listeners = [...this.listeners];
      this.listeners.clear();
      for (const listener of listeners) listener.failed(message);
    };
    child.on('error', (error) => exited(`could not start (${error.message})`));
    child.on('close', (code, signal) => exited(`exited (${signal ?? `code ${code}`})`));
  }

  add(listener: FeedListener): () => void {
    this.listeners.add(listener);
    for (const value of this.kept) listener.item(value);
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) void this.stop();
    };
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.child = null;
    this.listeners.clear();
    this.ended();
    return terminate(child);
  }
}

export class FeedPool {
  private readonly feeds = new Map<string, Feed>();
  private readonly stimCli: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(stimCli: string, env: NodeJS.ProcessEnv) {
    this.stimCli = stimCli;
    this.env = env;
  }

  subscribe(spec: FeedSpec, listener: FeedListener): () => void {
    const key = JSON.stringify([spec.cwd, spec.args]);
    let feed = this.feeds.get(key);
    if (!feed) {
      const created: Feed = new Feed(spec, this.stimCli, this.env, () => {
        if (this.feeds.get(key) === created) this.feeds.delete(key);
      });
      this.feeds.set(key, created);
      feed = created;
    }
    return feed.add(listener);
  }

  async close(): Promise<void> {
    await Promise.all([...this.feeds.values()].map((feed) => feed.stop()));
  }
}
