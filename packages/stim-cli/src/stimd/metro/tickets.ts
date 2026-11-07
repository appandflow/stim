import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Socket } from 'node:net';
import { isJsonObject } from '@stim-cli/core/state';
import { traceInvocation, withInvocation, type Invocation } from '../forwarded.ts';
import { ensureMetro } from './children.ts';

type Log = Parameters<typeof ensureMetro>[1];

export function createMetroTickets(log: Log) {
  const tickets = new Map<string, { owner: Socket; answer: ReturnType<typeof ensureMetro> }>();
  return {
    prepare(owner: Socket, params: unknown, context: Invocation & { workspace: string }, signal: AbortSignal): string {
      const fields = isJsonObject(params) ? params : {};
      if (typeof fields.root !== 'string' || realpathSync(fields.root) !== realpathSync(context.workspace))
        throw new Error('the Metro request does not match the operation workspace');
      const id = randomUUID();
      const answer = traceInvocation(context, 'stimd.metro', () =>
        withInvocation(context, signal, () => ensureMetro(fields, log, context.forwarded.env, signal)),
      );
      void answer.catch(() => {});
      tickets.set(id, { owner, answer });
      return id;
    },
    async wait(id: string, owner: Socket): Promise<Record<string, unknown>> {
      const ticket = tickets.get(id);
      if (!ticket || ticket.owner !== owner) throw new Error('the Metro ticket does not belong to this operation');
      try {
        return await ticket.answer;
      } finally {
        tickets.delete(id);
      }
    },
    drop(owner: Socket): void {
      for (const [id, ticket] of tickets) if (ticket.owner === owner) tickets.delete(id);
    },
  };
}

export type MetroTickets = ReturnType<typeof createMetroTickets>;

export function handleMetroTicketRequest({
  message,
  socket,
  tickets,
  operations,
  controllers,
  tokens,
}: {
  message: Record<string, unknown>;
  socket: Socket;
  tickets: MetroTickets;
  operations: Map<Socket, Invocation & { workspace: string }>;
  controllers: Map<Socket, AbortController>;
  tokens: Map<string, Socket>;
}): boolean {
  const { op } = message;
  if (op !== 'metro.prepare' && op !== 'metro.wait') return false;
  const owner = typeof message.opToken === 'string' ? tokens.get(message.opToken) : socket;
  const context = owner ? operations.get(owner) : undefined;
  const signal = owner ? controllers.get(owner)?.signal : undefined;
  const respond = (answer: Record<string, unknown>) => {
    if (socket.destroyed) return;
    if (operations.has(socket)) socket.write(`${JSON.stringify(answer)}\n`);
    else socket.end(`${JSON.stringify(answer)}\n`);
  };
  if (!owner || !context || !signal) {
    respond({ op: 'error', code: 'metro', message: 'the operation is no longer admitted' });
  } else if (op === 'metro.prepare') {
    try {
      const ticket = tickets.prepare(owner, message.params, context, signal);
      respond({ op: 'metro.prepared', state: 'starting', ticket });
    } catch (error) {
      respond({ op: 'error', code: 'metro', message: error instanceof Error ? error.message : String(error) });
    }
  } else {
    const fields = isJsonObject(message.params) ? message.params : {};
    if (typeof fields.ticket !== 'string') {
      respond({ op: 'error', code: 'metro', message: 'invalid Metro ticket' });
      return true;
    }
    void tickets
      .wait(fields.ticket, owner)
      .then(respond, (error: unknown) =>
        respond({ op: 'error', code: 'metro', message: error instanceof Error ? error.message : String(error) }),
      );
  }
  return true;
}
