import { registeredWorkspace, send, type ConnectionContext } from './context.ts';
import type { ErrorCode, RequestId } from '../protocol.ts';
import type { LocalAgentPresence } from '../local-agent-presence.ts';
import { parsePresencePublish, presenceKey } from '../presence.ts';

/** Records one agent action's presence; the refusal when `params` is malformed or names no registered workspace. */
export function recordPresence(
  localAgents: LocalAgentPresence,
  params: unknown,
): { code: ErrorCode; message: string } | null {
  const parsed = parsePresencePublish(params);
  if (typeof parsed === 'string') return { code: 'bad-request', message: parsed };
  const resolved = registeredWorkspace(parsed.workspace);
  if ('code' in resolved) return resolved;
  localAgents.published(
    presenceKey(resolved.dir, parsed.platform, parsed.slot ?? 'default', parsed.physical === true),
    parsed.command,
    parsed.phase,
    parsed.gesture,
  );
  return null;
}

export function publishPresence(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  if (!ctx.local) return ctx.error(id, 'forbidden', "presence.publish works only on this machine's local socket.");
  const refused = recordPresence(ctx.localAgents, params);
  if (refused) return ctx.error(id, refused.code, refused.message);
  send(ctx.socket, { id, result: {} });
}
