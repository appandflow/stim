import { Worker } from 'node:worker_threads';
import type { KitReply, KitRequest } from './kit-worker.ts';
import { spawnEntry } from './spawn-entry.ts';

const LOAD_TIMEOUT_MS = 10_000;

/** A plugin module's instance in a worker thread; every argument and result crosses a `MessagePort`. */
export interface KitWorker {
  id: string;
  /** The capabilities the instance has, of those asked for. */
  members: string[];
  /** The module-level capabilities the module has, of those asked for, as dotted paths such as `client.access`. */
  moduleMembers: string[];
  /** Calls an instance member. A rejection keeps the thrown error's message and its string `code`. */
  call(member: string, ...args: unknown[]): Promise<unknown>;
  /** Calls a module-level member by its dotted path. */
  callModule(member: string, ...args: unknown[]): Promise<unknown>;
  /** Calls the member with a listener whose values arrive as messages; the result stops it. */
  subscribe(member: string, listener: (value: unknown) => void): Promise<() => Promise<void>>;
  /** Why an event the module emitted could not cross the thread boundary. */
  failures: string[];
  terminate(): Promise<void>;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/**
 * Loads `href` in a worker thread, where a runtime `import 'stim'` fails, and calls its `factory` with `input`.
 * Resolves to `{ unavailable }` with the reason when the module does not load or the factory fails.
 */
export async function startKitWorker({
  href,
  factory,
  input,
  capabilities,
  moduleCapabilities = [],
  idMember = 'id',
  timeoutMs = LOAD_TIMEOUT_MS,
}: {
  href: string;
  factory: string;
  input: unknown;
  /** The optional members of the kind's contract; one that is present and not a function fails the load. */
  capabilities: readonly string[];
  /** The module-level members the kit may call, as dotted paths. */
  moduleCapabilities?: readonly string[];
  /** The instance member that holds its string id. */
  idMember?: string;
  timeoutMs?: number;
}): Promise<KitWorker | { unavailable: string }> {
  let worker: Worker;
  try {
    worker = new Worker(spawnEntry('kit-worker'), {
      workerData: { stimKit: true, href, factory, input, capabilities, moduleCapabilities, idMember },
    });
  } catch (error) {
    return { unavailable: `the input could not be cloned: ${error instanceof Error ? error.message : String(error)}` };
  }
  const pending = new Map<number, Pending>();
  const listeners = new Map<number, (value: unknown) => void>();
  const failures: string[] = [];
  let seq = 0;
  let died: Error | null = null;
  const fail = (error: Error) => {
    died ??= error;
    for (const each of pending.values()) each.reject(error);
    pending.clear();
  };
  const request = (build: (seq: number) => KitRequest) =>
    new Promise<unknown>((resolve, reject) => {
      if (died) return reject(died);
      const next = ++seq;
      pending.set(next, { resolve, reject });
      try {
        worker.postMessage(build(next));
      } catch (error) {
        pending.delete(next);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const ready = new Promise<Extract<KitReply, { type: 'ready' | 'failed' }>>((resolve) => {
    worker.on('message', (reply: KitReply) => {
      if (reply.type === 'ready' || reply.type === 'failed') return resolve(reply);
      if (reply.type === 'event') {
        listeners.get(reply.seq)?.(reply.value);
      } else if (reply.type === 'result') {
        pending.get(reply.seq)?.resolve(reply.value);
        pending.delete(reply.seq);
      } else if (pending.has(reply.seq)) {
        pending
          .get(reply.seq)
          ?.reject(Object.assign(new Error(reply.message), reply.code === undefined ? {} : { code: reply.code }));
        pending.delete(reply.seq);
      } else {
        failures.push(reply.message);
      }
    });
    worker.on('error', (error: Error) => {
      fail(error);
      resolve({ type: 'failed', message: error.message });
    });
    worker.on('exit', (code) => {
      fail(new Error(`the worker exited with code ${code}`));
      resolve({ type: 'failed', message: `the worker exited with code ${code}` });
    });
  });
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    ready,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (first === 'timeout' || first.type === 'failed') {
    await worker.terminate();
    return { unavailable: first === 'timeout' ? `the module did not load within ${timeoutMs}ms` : first.message };
  }
  return {
    id: first.id,
    members: first.members,
    moduleMembers: first.moduleMembers,
    failures,
    call: (member, ...args) => request((next) => ({ type: 'call', seq: next, member, args })),
    callModule: (member, ...args) => request((next) => ({ type: 'call', seq: next, member, args, module: true })),
    async subscribe(member, listener) {
      const target = seq + 1;
      listeners.set(target, listener);
      try {
        await request((next) => ({ type: 'subscribe', seq: next, member }));
      } catch (error) {
        listeners.delete(target);
        throw error;
      }
      return async () => {
        listeners.delete(target);
        await request((next) => ({ type: 'unsubscribe', seq: next, target }));
      };
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
