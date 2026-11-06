import { send, type ConnectionContext } from './context.ts';
import type { RequestId } from '../protocol.ts';
import type { PairedDevice } from '../registry.ts';

export async function updateMethod(
  ctx: ConnectionContext,
  id: RequestId,
  method: string,
  params: unknown,
  session: PairedDevice,
): Promise<void> {
  const registries = ctx.approved();
  const machine =
    !ctx.local &&
    (registries.build.some((entry) => entry.id === session.id && entry.capabilities.includes('build')) ||
      registries.deviceHost.some((entry) => entry.id === session.id && entry.capabilities.includes('device-host')));
  if (!machine) {
    return ctx.error(
      id,
      'forbidden',
      `${method} needs this machine's build or device-host approval of the requesting machine.`,
    );
  }
  if (method === 'engine.update.status') return send(ctx.socket, { id, result: await ctx.updates.status() });
  const answer =
    method === 'engine.update'
      ? await ctx.updates.start({ id: session.id, name: session.name }, params)
      : ctx.updates.chunk(session.id, params);
  send(ctx.socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
}
