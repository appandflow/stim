import type { ProcessRecord } from '../process-identity.ts';

export type Takeover = { action: 'none' } | { action: 'ask-handover'; build: unknown } | { action: 'sigterm' };

/**
 * How a starting daemon takes the claim from the running daemon `pid`, given `holder`, the live claim record of `pid`,
 * and `hello`, the reply of whatever answers the daemon socket. Only a live holder answering for itself is acted on: a
 * daemon whose `hello` carries `build` is asked to hand over, one from before handovers gets SIGTERM.
 */
export function decideTakeover(
  pid: number,
  holder: ProcessRecord | null,
  hello: Record<string, unknown> | null,
): Takeover {
  if (!holder || hello?.pid !== pid) return { action: 'none' };
  return 'build' in hello ? { action: 'ask-handover', build: hello.build } : { action: 'sigterm' };
}
