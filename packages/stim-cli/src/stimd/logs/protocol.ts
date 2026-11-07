import { realpathSync } from 'node:fs';
import type { Socket } from 'node:net';
import { isJsonObject } from '@stim-cli/core/state';
import { traceInvocation, withInvocation, type Invocation } from '../forwarded.ts';
import { parseStreamSpec, type StreamTable } from './streams.ts';

export function handleLogRequest({
  message,
  socket,
  streams,
  operations,
  controllers,
  tokens,
  attached,
}: {
  message: Record<string, unknown>;
  socket: Socket;
  streams: StreamTable;
  operations: Map<Socket, Invocation & { workspace: string }>;
  controllers: Map<Socket, AbortController>;
  tokens: Map<string, Socket>;
  attached: boolean;
}): boolean {
  if (message.op !== 'logs.start' && message.op !== 'logs.stop' && message.op !== 'readiness.wait') return false;
  const respond = (answer: Record<string, unknown>) => {
    if (socket.destroyed) return;
    if (operations.has(socket)) socket.write(`${JSON.stringify({ ...answer, requestId: message.requestId })}\n`);
    else socket.end(`${JSON.stringify(answer)}\n`);
  };
  if (message.op === 'logs.start') {
    const owner = typeof message.opToken === 'string' ? tokens.get(message.opToken) : socket;
    const context = owner ? operations.get(owner) : undefined;
    const spec = parseStreamSpec(message.params);
    let matches = false;
    try {
      matches = Boolean(context && spec && realpathSync(context.workspace) === realpathSync(spec.root));
    } catch {}
    if (!context || !spec || !matches) {
      respond({ op: 'error', code: 'bad-workspace', message: 'the log stream does not match an admitted operation' });
      return true;
    }
    if (attached && spec.platform === 'ios' && spec.physical) {
      respond({
        op: 'error',
        code: 'logs.start',
        message:
          'A physical iOS console cannot use an attached stimd. Run `stim serve` in a foreground terminal, then retry.',
      });
      return true;
    }
    const signal = owner ? controllers.get(owner)?.signal : undefined;
    if (!signal) {
      respond({ op: 'error', code: 'logs.start', message: 'the operation is no longer admitted' });
      return true;
    }
    void traceInvocation(context, 'stimd.logs.start', () =>
      withInvocation(context, signal, () => streams.start(spec, context.forwarded.env, signal)),
    ).then(
      (result) => respond({ op: 'logs.started', ...result }),
      (error: unknown) =>
        respond({ op: 'error', code: 'logs.start', message: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.op === 'readiness.wait') {
    const owner = typeof message.opToken === 'string' ? tokens.get(message.opToken) : socket;
    const context = owner ? operations.get(owner) : undefined;
    const fields = isJsonObject(message.params) ? message.params : {};
    let matches = false;
    try {
      matches = Boolean(
        context && typeof fields.root === 'string' && realpathSync(context.workspace) === realpathSync(fields.root),
      );
    } catch {}
    if (
      !context ||
      !matches ||
      typeof fields.root !== 'string' ||
      typeof fields.platform !== 'string' ||
      typeof fields.slot !== 'string' ||
      typeof fields.streamId !== 'string' ||
      !Number.isSafeInteger(fields.since) ||
      Number(fields.since) < 0 ||
      !Number.isSafeInteger(fields.after) ||
      Number(fields.after) < 0 ||
      !Number.isSafeInteger(fields.timeoutMs) ||
      Number(fields.timeoutMs) < 0 ||
      Number(fields.timeoutMs) > 30_000
    ) {
      respond({ op: 'error', code: 'readiness.wait', message: 'invalid readiness wait or operation' });
      return true;
    }
    const { root, platform, slot, streamId } = fields;
    const signal = owner ? controllers.get(owner)?.signal : undefined;
    if (!signal) {
      respond({ op: 'error', code: 'readiness.wait', message: 'the operation is no longer admitted' });
      return true;
    }
    void traceInvocation(context, 'stimd.readiness.wait', () =>
      withInvocation(context, signal, () =>
        streams.wait(
          root,
          platform,
          slot,
          streamId,
          Number(fields.since),
          Number(fields.after),
          Number(fields.timeoutMs),
          signal,
          context.forwarded.env,
        ),
      ),
    ).then(
      (result) => respond({ op: 'readiness.changed', ...result }),
      (error: unknown) =>
        respond({
          op: 'error',
          code: 'readiness.wait',
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  }
  const fields = isJsonObject(message.params) ? message.params : {};
  if (
    typeof fields.root !== 'string' ||
    typeof fields.platform !== 'string' ||
    typeof fields.slot !== 'string' ||
    typeof fields.streamId !== 'string'
  ) {
    respond({ op: 'error', code: 'logs.stop', message: 'invalid log stream identity' });
    return true;
  }
  void streams.stop(fields.root, fields.platform, fields.slot, fields.streamId).then(
    (wasStopped) => respond({ op: 'logs.stopped', stopped: wasStopped }),
    (error: unknown) =>
      respond({ op: 'error', code: 'logs.stop', message: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}
