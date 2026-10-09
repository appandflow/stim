import type { ChildProcess } from 'node:child_process';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import { createLineReader } from '../process-output.ts';

interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface ChildServerHandle {
  mode: string;
  serverPid: number | null;
  child: ChildProcess;
  onExit(cb: (info: ChildExitInfo | null) => void): void;
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

export function superviseChildServer({
  mode,
  child,
  log,
  toRecord,
  signal,
  alive = null,
  killTimeoutMs,
  onRecord = null,
}: {
  mode: string;
  child: ChildProcess;
  log: NdjsonWriter;
  toRecord: (chunk: unknown, stream: 'stdout' | 'stderr') => NdjsonRecord | null;
  signal: (sig: NodeJS.Signals) => boolean;
  alive?: (() => boolean) | null;
  killTimeoutMs: number;
  onRecord?: ((record: NdjsonRecord) => void) | null;
}): ChildServerHandle {
  let lastMsg: string | null = null;
  let lastAt = 0;
  const emit = (stream: 'stdout' | 'stderr') => (chunk: unknown) => {
    const record = toRecord(chunk, stream);
    if (!record) return;
    const now = Date.now();
    if (record.msg === lastMsg && now - lastAt < 1000) return;
    lastMsg = typeof record.msg === 'string' ? record.msg : null;
    lastAt = now;
    log.write(record);
    onRecord?.(record);
  };
  const outReader = createLineReader(emit('stdout'));
  const errReader = createLineReader(emit('stderr'));
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  let exited = false;
  let exitInfo: ChildExitInfo | null = null;
  const listeners: ((info: ChildExitInfo | null) => void)[] = [];
  child.on('exit', (code, sig) => {
    exited = true;
    exitInfo = { code, signal: sig };
    outReader.flush();
    errReader.flush();
    for (const cb of listeners) cb(exitInfo);
  });
  child.on('error', (err) => {
    if (exited) return;
    exited = true;
    exitInfo = { code: null, signal: null, error: err };
    for (const cb of listeners) cb(exitInfo);
  });

  return {
    mode,
    serverPid: child.pid ?? null,
    child,
    onExit(cb) {
      if (exited) {
        cb(exitInfo);
        return;
      }
      listeners.push(cb);
    },
    async close() {
      const running = () => (alive ? alive() : !exited && Boolean(child.pid));
      const gone = async () => {
        const deadline = Date.now() + killTimeoutMs;
        while (running() && Date.now() < deadline) await delay(25);
        return !running();
      };
      if (!running() || !signal('SIGTERM')) return;
      if (!(await gone())) {
        signal('SIGKILL');
        await gone();
      }
    },
  };
}
