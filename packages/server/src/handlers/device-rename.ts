import { isJsonObject } from '@stim-cli/core/state';
import type { AuditRecord } from '../actions.ts';
import type { ErrorCode, RequestId } from '../protocol.ts';
import { renameDevice, type PairedDevice } from '../registry.ts';
import { auditSafely, send, type ConnectionContext } from './context.ts';

export function renameSelf(ctx: ConnectionContext, id: RequestId, params: unknown, session: PairedDevice): void {
  const record: AuditRecord = {
    at: new Date().toISOString(),
    device: { id: session.id, name: session.name },
    action: 'device.rename',
    workspace: null,
    ok: false,
  };
  const refuse = (code: ErrorCode, message: string) => {
    auditSafely({ ...record, error: { code, message } });
    ctx.error(id, code, message);
  };
  if (!isJsonObject(params) || typeof params.id !== 'string' || typeof params.name !== 'string') {
    return refuse('bad-request', 'device.rename takes an object with string id and name.');
  }
  if (params.id !== session.id) {
    return refuse('forbidden', "device.rename renames only this connection's own record.");
  }
  const outcome = renameDevice(session.id, params.name);
  if (outcome === 'invalid-name') {
    return refuse('bad-request', 'The name must be 1 to 64 characters of printable text on one line.');
  }
  if (outcome === 'unknown') return refuse('unauthorized', 'This device is no longer paired.');
  const name = params.name.trim();
  session.name = name;
  auditSafely({ ...record, ok: true, name });
  send(ctx.socket, { id, result: { name } });
}
