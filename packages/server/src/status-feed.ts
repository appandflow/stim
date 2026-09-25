import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { isJsonObject, type StatusPayload } from '@stim-cli/core/state';

export interface StatusListener {
  payload: (payload: StatusPayload) => void;
  failed: (message: string) => void;
}

const STDERR_TAIL = 2000;

export class StatusFeed {
  private readonly listeners = new Set<StatusListener>();
  private child: ChildProcess | null = null;
  private last: StatusPayload | null = null;

  private readonly stimCli: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(stimCli: string, env: NodeJS.ProcessEnv) {
    this.stimCli = stimCli;
    this.env = env;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    if (!this.child) this.start();
    else if (this.last) listener.payload(this.last);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  close(): void {
    this.listeners.clear();
    this.stop();
  }

  private start(): void {
    const child = spawn(process.execPath, [this.stimCli, 'status', '--watch', '--json'], {
      cwd: homedir(),
      env: this.env,
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
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      if (!isJsonObject(payload)) return;
      this.last = payload as unknown as StatusPayload;
      for (const listener of this.listeners) listener.payload(this.last);
    });
    const ended = (reason: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.last = null;
      const message = `stim status --watch ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
      const listeners = [...this.listeners];
      this.listeners.clear();
      for (const listener of listeners) listener.failed(message);
    };
    child.on('error', (error) => ended(`could not start (${error.message})`));
    child.on('close', (code, signal) => ended(`exited (${signal ?? `code ${code}`})`));
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    this.last = null;
    child?.kill('SIGTERM');
  }
}
