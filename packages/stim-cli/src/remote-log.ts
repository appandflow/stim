import type { StimContext } from '@stim-cli/core';

type Sink = (record: Record<string, unknown>) => void;

const sinks = new WeakMap<StimContext, Sink>();

/** Where this operation's failed remote requests are written for `stim logs`. */
export function setRemoteLogSink(context: StimContext, next: Sink | null): void {
  if (next) sinks.set(context, next);
  else sinks.delete(context);
}

export function reportRemoteFailure(
  context: StimContext | undefined,
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    if (context) sinks.get(context)?.({ src: 'build', level: 'warn', event, ...fields });
  } catch {}
}
