import type { Socket } from 'node:net';
import { Worker } from 'node:worker_threads';
import { spawnEntry } from '../spawn-entry.ts';

const STOP_WAIT_MS = 15_000;

/** The options of `stim serve`, a service unit or a request to stimd, as the net thread takes them. */
export interface NetOptions {
  port: number;
  extraEnv: string[];
  pathPrepend: string[];
  loopbackOnly: boolean;
  shareOnly: boolean;
  desktopKey: string;
  owner?: 'desktop';
  script: string;
}

type ToNet =
  | { type: 'open'; id: number }
  | { type: 'data'; id: number; chunk: Uint8Array }
  | { type: 'end'; id: number }
  | { type: 'presence'; params: unknown }
  | { type: 'hosted-drained'; id: number; error: string | null }
  | { type: 'keep' }
  | { type: 'stop' };

type FromNet =
  | { type: 'listening'; port: number }
  | { type: 'refused'; message: string }
  | { type: 'data'; id: number; chunk: Uint8Array }
  | { type: 'end'; id: number }
  | { type: 'idle' }
  | { type: 'update'; why: string };

/** Whether the net thread serves, on which port, or why it does not. */
type NetAnswer = { listening: true; port: number } | { listening: false; message: string };

export interface NetThread {
  /** Starts the net thread with `options` unless it runs; resolves once it listens or refuses. */
  ensure(options: NetOptions): Promise<NetAnswer>;
  /** Whether the net thread runs, with which options, and on which port once it listens. */
  running(): { shareOnly: boolean; loopbackOnly: boolean; port: number | null } | null;
  /** Hands `socket`, whose first frames stimd has read, to a listening net thread; false when none listens. */
  connect(socket: Socket, head: Buffer): boolean;
  /** Forwards one agent action's presence to a listening net thread; false when none listens. */
  presence(params: unknown): boolean;
  /** Stops the net thread and waits for it. */
  close(): Promise<void>;
}

/**
 * stimd's net thread: stim-server's listeners and handlers, run from the `net-thread` entry so stimd's own code imports
 * none of them. One start at a time; every request made while it starts gets that start's answer.
 */
export function createNetThread(
  log: (level: 'info' | 'warn', event: string, msg: string) => void,
  onExit: () => void,
  onUpdate: (why: string) => void = () => {},
  drainHosted: (session: string) => Promise<string | null> = async () => 'hosted observer is unavailable',
): NetThread {
  let worker: Worker | null = null;
  let started: Promise<NetAnswer> | null = null;
  let stopping: Promise<unknown> | null = null;
  let listening = false;
  let shareOnly = false;
  let loopbackOnly = false;
  let port: number | null = null;
  let nextId = 1;
  const sockets = new Map<number, Socket>();
  const post = (message: ToNet) => worker?.postMessage(message);
  const stop = (thread: Worker) => {
    listening = false;
    stopping ??= new Promise((done) => thread.once('exit', done));
    thread.postMessage({ type: 'stop' });
  };
  const ended = () => {
    worker = null;
    started = null;
    stopping = null;
    listening = false;
    port = null;
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear();
    onExit();
  };
  return {
    ensure(options): Promise<NetAnswer> {
      if (stopping) return stopping.then(() => this.ensure(options));
      if (started) {
        if (!options.shareOnly && shareOnly) {
          shareOnly = false;
          post({ type: 'keep' });
        }
        return started;
      }
      shareOnly = options.shareOnly;
      loopbackOnly = options.loopbackOnly;
      const thread = new Worker(spawnEntry('net-thread'), { workerData: { net: options } });
      worker = thread;
      started = new Promise<NetAnswer>((answer) => {
        thread.on('message', (message: FromNet | { type: 'hosted-drain'; id: number; session: string }) => {
          if (message.type === 'listening') {
            listening = true;
            port = message.port;
            log('info', 'net_started', `the net thread listens on port ${message.port}`);
            answer({ listening: true, port: message.port });
          } else if (message.type === 'refused') {
            log('warn', 'net_refused', message.message);
            answer({ listening: false, message: message.message });
            void thread.terminate();
          } else if (message.type === 'idle') {
            if (!shareOnly) return;
            log('info', 'net_idle', 'no web share is left; stopping the net thread');
            stop(thread);
          } else if (message.type === 'update') onUpdate(message.why);
          else if (message.type === 'hosted-drain')
            void drainHosted(message.session).then(
              (error) => thread.postMessage({ type: 'hosted-drained', id: message.id, error }),
              (error: unknown) => thread.postMessage({ type: 'hosted-drained', id: message.id, error: String(error) }),
            );
          else if (message.type === 'data') sockets.get(message.id)?.write(message.chunk);
          else sockets.get(message.id)?.end();
        });
        thread.once('error', (error: Error) => {
          log('warn', 'net_failed', error.message);
          answer({ listening: false, message: `the net thread failed: ${error.message}` });
        });
        thread.once('exit', (code) => {
          answer({ listening: false, message: `the net thread exited with code ${code}` });
          if (worker === thread) ended();
        });
      });
      return started;
    },
    running: () => (worker ? { shareOnly, loopbackOnly, port } : null),
    connect(socket, head) {
      if (!listening) return false;
      const id = nextId++;
      sockets.set(id, socket);
      post({ type: 'open', id });
      if (head.length) post({ type: 'data', id, chunk: new Uint8Array(head) });
      socket.on('data', (chunk: Buffer) => post({ type: 'data', id, chunk: new Uint8Array(chunk) }));
      socket.once('close', () => {
        if (sockets.delete(id)) post({ type: 'end', id });
      });
      return true;
    },
    presence(params) {
      if (!listening) return false;
      post({ type: 'presence', params });
      return true;
    },
    async close() {
      const thread = worker;
      if (!thread) return;
      stop(thread);
      const timer = setTimeout(() => void thread.terminate(), STOP_WAIT_MS);
      await new Promise((done) => thread.once('exit', done));
      clearTimeout(timer);
    },
  };
}
