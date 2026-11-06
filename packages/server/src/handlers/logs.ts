import { send, readFailure, type ConnectionContext } from './context.ts';
import type { RequestId } from '../protocol.ts';
import { parseLogFilter, LogBatcher, archivedLogs } from '../logs.ts';
import { agentActionReaders } from '../agent-drivers.ts';
import { createStim } from 'stim';

export function subscribeLogs(
  ctx: ConnectionContext,
  id: RequestId,
  params: unknown,
  fullBackfill = false,
): void | Promise<void> {
  const parsed = parseLogFilter(params);
  if ('error' in parsed) return ctx.error(id, 'bad-request', parsed.error);
  const cwd = ctx.readDir(id, parsed.filter);
  if (!cwd) return;
  const subscription = ctx.openSubscription(id);
  if (!subscription) return;
  const end = () => {
    ctx.subscriptions.get(subscription)?.();
    ctx.subscriptions.delete(subscription);
  };
  const batcher = new LogBatcher(
    {
      send: (records) => send(ctx.socket, { event: 'logs', subscription, records }),
      bufferedBytes: () => ctx.socket.bufferedAmount,
      ended: () => {
        end();
        send(ctx.socket, { event: 'logs-ended', subscription });
      },
      overflow: () => {
        end();
        send(ctx.socket, {
          event: 'error',
          subscription,
          error: { code: 'slow-client', message: 'This client fell behind the log stream. Subscribe again.' },
        });
      },
    },
    ctx.logLimits,
  );
  if (parsed.filter.archive !== undefined) {
    ctx.subscriptions.set(subscription, () => batcher.stop());
    return agentActionReaders().then((actions) => {
      for (const record of archivedLogs(cwd, parsed.filter, actions)) batcher.push(record);
      return batcher.finish();
    });
  }
  const abort = new AbortController();
  let stop: (() => void) | undefined;
  const deadline = setTimeout(() => {
    abort.abort();
    batcher.stop();
    ctx.subscriptions.delete(subscription);
    send(ctx.socket, {
      event: 'error',
      subscription,
      error: {
        code: 'logs-failed',
        message: `stim logs did not finish within ${ctx.commandLimits.timeoutMs / 1000} s.`,
      },
    });
  }, ctx.commandLimits.timeoutMs);
  ctx.subscriptions.set(subscription, () => {
    clearTimeout(deadline);
    abort.abort();
    batcher.stop();
    stop?.();
  });
  const task = Promise.resolve()
    .then(() =>
      createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).followLogs(
        {
          sources: parsed.filter.sources,
          minLevel: parsed.filter.level,
          slot: parsed.filter.slot,
          grep: parsed.filter.grep,
          errorsOnly: parsed.filter.errors,
          tail: fullBackfill ? undefined : parsed.filter.tail,
          signal: abort.signal,
        },
        (record) => {
          if (!abort.signal.aborted) batcher.push(record);
        },
        fullBackfill ? (records) => batcher.backfill(records, abort.signal) : undefined,
      ),
    )
    .then(
      (unsubscribe) => {
        clearTimeout(deadline);
        stop = unsubscribe;
        if (abort.signal.aborted) stop();
        return undefined;
      },
      (cause: unknown) => {
        clearTimeout(deadline);
        if (abort.signal.aborted) return;
        batcher.flush(true);
        batcher.stop();
        ctx.subscriptions.delete(subscription);
        send(ctx.socket, { event: 'error', subscription, error: { code: 'logs-failed', message: readFailure(cause) } });
      },
    )
    .finally(() => ctx.running.delete(cancel));
  const cancel = async () => {
    abort.abort();
    await task;
  };
  ctx.running.add(cancel);
}

export function queryLogs(ctx: ConnectionContext, id: RequestId, params: unknown): void | Promise<void> {
  const parsed = parseLogFilter(params);
  if ('error' in parsed) return ctx.error(id, 'bad-request', parsed.error);
  const cwd = ctx.readDir(id, parsed.filter);
  if (!cwd) return;
  if (parsed.filter.archive !== undefined) {
    return agentActionReaders().then((actions) =>
      send(ctx.socket, { id, result: { records: archivedLogs(cwd, parsed.filter, actions) } }),
    );
  }
  ctx.inProcessRead<'logs.query'>(id, 'stim logs', async (signal) => ({
    records: await createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).logs({
      sources: parsed.filter.sources,
      minLevel: parsed.filter.level,
      slot: parsed.filter.slot,
      grep: parsed.filter.grep,
      errorsOnly: parsed.filter.errors,
      tail: parsed.filter.tail,
      signal,
    }),
  }));
}
