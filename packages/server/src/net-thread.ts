import { Duplex } from 'node:stream';
import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { NetRefusal, serve, type NetOptions } from './cli.ts';

/** What stimd's main thread sends the net thread. */
export type ToNet =
  | { type: 'open'; id: number }
  | { type: 'data'; id: number; chunk: Uint8Array }
  | { type: 'end'; id: number }
  | { type: 'presence'; params: unknown }
  | { type: 'hosted-drained' | 'hosted-observed'; id: number; error: string | null }
  | { type: 'keep' }
  | { type: 'stop' };

/** What the net thread sends stimd's main thread. */
export type FromNet =
  | { type: 'listening'; port: number }
  | { type: 'refused'; message: string; clean: boolean }
  | { type: 'closed'; error?: string }
  | { type: 'data'; id: number; chunk: Uint8Array }
  | { type: 'end'; id: number }
  | { type: 'idle' }
  | { type: 'update'; why: string };

/** A connection stimd's CLI socket handed over, carried as messages. */
class Bridged extends Duplex {
  readonly id: number;
  readonly #post: (message: FromNet) => void;

  constructor(id: number, post: (message: FromNet) => void) {
    super();
    this.id = id;
    this.#post = post;
  }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.#post({ type: 'data', id: this.id, chunk: new Uint8Array(chunk) });
    done();
  }
  override _final(done: () => void): void {
    this.#post({ type: 'end', id: this.id });
    done();
  }
  override _destroy(error: Error | null, done: (error: Error | null) => void): void {
    this.#post({ type: 'end', id: this.id });
    done(error);
  }
}

async function run(port: MessagePort, options: NetOptions): Promise<void> {
  const post = (message: FromNet) => port.postMessage(message);
  const connections = new Map<number, Bridged>();
  let nextDrain = 1;
  const drains = new Map<number, (error: string | null) => void>();
  const drainHosted = (session: string) =>
    new Promise<string | null>((done) => {
      const id = nextDrain++;
      const timer = setTimeout(() => {
        drains.delete(id);
        done('hosted observer did not answer');
      }, 10_000);
      drains.set(id, (error) => {
        clearTimeout(timer);
        done(error);
      });
      port.postMessage({ type: 'hosted-drain', id, session });
    });
  const observeHosted = (session: string, pid: number, token: string, launchId: string) =>
    new Promise<string | null>((done) => {
      const id = nextDrain++;
      const timer = setTimeout(() => {
        drains.delete(id);
        done('hosted observer did not answer');
      }, 10_000);
      drains.set(id, (error) => {
        clearTimeout(timer);
        done(error);
      });
      port.postMessage({ type: 'hosted-observe', id, session, pid, token, launchId });
    });
  const pending: ToNet[] = [];
  let handle: (message: ToNet) => void = (message) => void pending.push(message);
  port.on('message', (message: ToNet) => handle(message));
  let thread;
  try {
    thread = await serve(
      options,
      () => post({ type: 'idle' }),
      (why) => post({ type: 'update', why }),
      drainHosted,
      observeHosted,
    );
  } catch (error) {
    post({
      type: 'refused',
      message: error instanceof NetRefusal ? error.message : String((error as Error).stack),
      clean: error instanceof NetRefusal,
    });
    port.close();
    return;
  }
  const { server, keep, close } = thread;
  handle = (message) => {
    if (message.type === 'open') {
      const stream = new Bridged(message.id, post);
      connections.set(message.id, stream);
      stream.once('close', () => connections.delete(message.id));
      server.acceptLocal(stream);
    } else if (message.type === 'hosted-drained' || message.type === 'hosted-observed') {
      drains.get(message.id)?.(message.error);
      drains.delete(message.id);
    } else if (message.type === 'data') connections.get(message.id)?.push(Buffer.from(message.chunk));
    else if (message.type === 'end') connections.get(message.id)?.push(null);
    else if (message.type === 'presence') server.publishPresence(message.params);
    else if (message.type === 'keep') keep();
    else
      void close()
        .then(
          () => post({ type: 'closed' }),
          (error: unknown) => post({ type: 'closed', error: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => port.close());
  };
  for (const message of pending.splice(0)) handle(message);
  post({ type: 'listening', port: server.addresses[0]?.port ?? options.port });
}

if (!isMainThread && parentPort && workerData?.net) await run(parentPort, workerData.net);
