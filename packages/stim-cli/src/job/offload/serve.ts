import type { Readable, Writable } from 'node:stream';
import { JobFrameReader, jobFrame } from '@stim-cli/core/noise-session';
import { OFFLOAD_JOB_METHODS, type OffloadJobKind, type ProtocolError } from '@stim-cli/core/protocol';
import { isJsonObject } from '@stim-cli/core/state';
import { appendAudit, type BuildLimits } from '@stim-cli/server/build';
import { BuildHost } from './host.ts';

/** What stimd tells an offload job in `STIM_JOB_SPEC`: the client it serves and the worker's build limits. */
export interface OffloadJobSpec {
  client: string;
  clientName: string;
  limits?: Partial<BuildLimits>;
}

/** The exit code that tells stimd the client sent a message the job refuses, so it closes with 4400. */
export const JOB_BAD_REQUEST = 64;

type Answer = { result: unknown } | { error: ProtocolError };

/**
 * Serves one client's offload methods over stdin and stdout, one Noise message per frame, until stdin ends or SIGTERM:
 * `offload-build` every method of {@link OFFLOAD_JOB_METHODS}, `offload-probe` only `build.offer`. `worker` is the
 * script and arguments that start the offload worker's modes. Resolves the exit code.
 */
export async function serveOffloadJob(
  kind: OffloadJobKind,
  spec: OffloadJobSpec,
  input: Readable,
  output: Writable,
  stop: AbortSignal,
  worker: readonly string[],
): Promise<number> {
  const host = new BuildHost({
    worker: worker[0]!,
    workerArgs: worker.slice(1),
    env: process.env,
    limits: spec.limits,
    finished: ({ client, repo, ok, error, durationMs }) =>
      appendAudit({
        at: new Date().toISOString(),
        device: { id: client, name: spec.clientName },
        action: 'build',
        workspace: repo,
        ok,
        ...(error ? { error } : {}),
        durationMs,
      }),
  });
  let open = true;
  const write = (data: Buffer, binary: boolean) => {
    if (open) output.write(jobFrame(data, binary));
  };
  const send = (message: unknown) => write(Buffer.from(JSON.stringify(message)), false);
  const socket = {
    OPEN: 1,
    get readyState() {
      return open ? 1 : 3;
    },
    get bufferedAmount() {
      return output.writableLength;
    },
    send: (data: Buffer, options: { binary: boolean }) => write(data, options.binary),
  };
  const session = host.session(spec.client, socket, send);
  const answer = async (method: string, params: unknown): Promise<Answer> => {
    if (method === 'build.offer') return host.offer(spec.client, params, session.signal);
    if (kind === 'offload-probe' || !(OFFLOAD_JOB_METHODS as readonly string[]).includes(method))
      return { error: { code: 'unknown-method', message: `Unknown method ${method}.` } };
    if (method === 'build.sync') return session.sync(params);
    if (method === 'build.start') return session.start(params);
    if (method === 'build.cancel') return session.cancel(params);
    if (method === 'build.attach') return session.attach(params);
    if (method === 'build.cached-artifact') return session.cachedArtifact(params);
    return session.artifact(params);
  };
  let code = 0;
  const ended = new Promise<void>((resolve) => {
    const reader = new JobFrameReader();
    let queue = Promise.resolve();
    const end = (exit: number) => {
      if (!open) return;
      code = exit;
      open = false;
      input.off('data', onData);
      resolve();
    };
    const handle = async (data: Buffer, binary: boolean) => {
      if (!open) return;
      if (binary) {
        const refused = session.blob(data);
        if (refused) {
          console.error(`stim offload job: ${refused}`);
          end(JOB_BAD_REQUEST);
        }
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        message = null;
      }
      if (!isJsonObject(message) || typeof message.method !== 'string') return end(JOB_BAD_REQUEST);
      const { id, method, params } = message;
      const reply = await answer(method, params);
      send('error' in reply ? { id, error: reply.error } : { id, result: reply.result });
    };
    const onData = (chunk: Buffer) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        return end(JOB_BAD_REQUEST);
      }
      for (const frame of frames) queue = queue.then(() => handle(frame.data, frame.binary)).catch(() => end(1));
    };
    input.on('data', onData);
    input.once('end', () => void queue.then(() => end(0)));
    input.once('error', () => end(0));
    stop.addEventListener('abort', () => end(0), { once: true });
  });
  await ended;
  session.close();
  await host.close();
  return code;
}
