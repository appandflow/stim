import { registeredWorkspace, send, type ConnectionContext } from './context.ts';
import type { RequestId } from '../protocol.ts';
import { parsePresencePublish, presenceKey } from '../presence.ts';

export function publishPresence(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  if (!ctx.local) return ctx.error(id, 'forbidden', "presence.publish works only on this machine's local Unix socket.");
  const parsed = parsePresencePublish(params);
  if (typeof parsed === 'string') return ctx.error(id, 'bad-request', parsed);
  const resolved = registeredWorkspace(parsed.workspace);
  if ('code' in resolved) return ctx.error(id, resolved.code, resolved.message);
  ctx.localAgents.published(
    presenceKey(resolved.dir, parsed.platform, parsed.slot ?? 'default', parsed.physical === true),
    parsed.command,
    parsed.phase,
    parsed.gesture,
  );
  send(ctx.socket, { id, result: {} });
}
