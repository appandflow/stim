import { realpathSync } from 'node:fs';
import { isJsonObject } from '@stim-cli/core/state';
import { traceInvocation, withInvocation, type Invocation } from './forwarded.ts';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { acquireRunLease, type AcquireRunLeaseResult } from '../engine/device-lease-run.ts';
import { releaseRunLease, type LeasePlatform } from '../engine/device-lease.ts';
import { loadConfig } from '../workspace/config.ts';

type LeaseRequest = {
  root: string;
  platform: LeasePlatform;
  slot: string;
  id: string;
  deviceName: string | null;
  idLabel: string;
  waitSeconds: number;
  noWait: boolean;
  installBoundMs: number;
  appId: string | null;
};
type Ticket = {
  owner: Socket;
  request: LeaseRequest;
  signal: AbortSignal;
  cancel: () => void;
  result?: AcquireRunLeaseResult;
  pending?: Promise<AcquireRunLeaseResult>;
};

const key = (request: LeaseRequest, token: string) => `${request.root}\0${request.platform}\0${request.slot}\0${token}`;

const device = (request: LeaseRequest) => `${request.platform}\0${request.id}`;
const scope = (request: LeaseRequest) => `${request.root}\0${request.platform}\0${request.slot}`;

export function createLeaseTickets(log: (message: string) => void = () => {}) {
  const tickets = new Map<string, Ticket>();
  const references = new Map<string, number>();
  const inflight = new Map<string, number>();
  const deferred = new Map<string, { request: LeaseRequest; token: string }>();
  const waiters = new Map<string, Set<() => void>>();
  const wake = (request: LeaseRequest) => {
    for (const resume of waiters.get(device(request)) ?? []) resume();
  };
  const sleep = (request: LeaseRequest, signal: AbortSignal, ms: number) =>
    new Promise<void>((resolve) => {
      const id = device(request);
      const set = waiters.get(id) ?? new Set<() => void>();
      waiters.set(id, set);
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0) waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  const releaseOwned = (request: LeaseRequest, token: string) => {
    try {
      releaseRunLease({ ...request, token });
      wake(request);
    } catch (error) {
      log(`device lease release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const flush = (request: LeaseRequest) => {
    if (inflight.has(scope(request))) return;
    for (const [ref, item] of deferred) {
      if (scope(item.request) !== scope(request)) continue;
      deferred.delete(ref);
      if (!references.has(ref)) {
        releaseOwned(item.request, item.token);
      }
    }
  };
  const release = (ticket: Ticket) => {
    const result = ticket.result;
    ticket.result = undefined;
    if (result?.status !== 'leased' || result.kind !== 'run' || !result.token) return;
    const ref = key(ticket.request, result.token);
    const remaining = (references.get(ref) ?? 1) - 1;
    if (remaining > 0) references.set(ref, remaining);
    else {
      references.delete(ref);
      if (inflight.has(scope(ticket.request))) deferred.set(ref, { request: ticket.request, token: result.token });
      else {
        releaseOwned(ticket.request, result.token);
      }
    }
  };
  return {
    prepare(owner: Socket, request: LeaseRequest, signal: AbortSignal): string {
      const id = randomUUID();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const cancel = () => {
        signal.removeEventListener('abort', abort);
        controller.abort();
      };
      tickets.set(id, { owner, request, signal: controller.signal, cancel });
      return id;
    },
    async acquire(id: string, owner: Socket, warn: (line: string) => void): Promise<AcquireRunLeaseResult> {
      const ticket = tickets.get(id);
      if (!ticket || ticket.owner !== owner) throw new Error('the device ticket does not belong to this operation');
      ticket.signal.throwIfAborted();
      if (!ticket.pending) {
        const deviceKey = scope(ticket.request);
        inflight.set(deviceKey, (inflight.get(deviceKey) ?? 0) + 1);
        ticket.pending = acquireRunLease({
          ...ticket.request,
          signal: ticket.signal,
          sleep: (ms) => sleep(ticket.request, ticket.signal, ms),
          warn,
          holderAppId: (holder) => {
            const project = loadConfig()?.projects?.[holder];
            return ticket.request.platform === 'ios' ? (project?.bundleId ?? null) : (project?.androidPackage ?? null);
          },
        })
          .then((result) => {
            ticket.result = result;
            if (result.status === 'leased' && result.kind === 'run' && result.token) {
              const ref = key(ticket.request, result.token);
              references.set(ref, (references.get(ref) ?? 0) + 1);
            }
            if (ticket.signal.aborted || !tickets.has(id)) release(ticket);
            return result;
          })
          .finally(() => {
            const remaining = (inflight.get(deviceKey) ?? 1) - 1;
            if (remaining) inflight.set(deviceKey, remaining);
            else inflight.delete(deviceKey);
            flush(ticket.request);
          });
      }
      return ticket.pending;
    },
    release(id: string, owner: Socket): void {
      const ticket = tickets.get(id);
      if (!ticket || ticket.owner !== owner) return;
      tickets.delete(id);
      ticket.cancel();
      release(ticket);
    },
    drop(owner: Socket): void {
      for (const [id, ticket] of tickets) {
        if (ticket.owner !== owner) continue;
        tickets.delete(id);
        ticket.cancel();
        release(ticket);
      }
    },
  };
}

export type LeaseTickets = ReturnType<typeof createLeaseTickets>;

export function handleLeaseRequest({
  message,
  socket,
  tickets,
  operations,
  controllers,
  tokens,
}: {
  message: Record<string, unknown>;
  socket: Socket;
  tickets: LeaseTickets;
  operations: Map<Socket, Invocation & { workspace: string }>;
  controllers: Map<Socket, AbortController>;
  tokens: Map<string, Socket>;
}): boolean {
  const { op } = message;
  if (op !== 'lease.prepare' && op !== 'lease.acquire' && op !== 'lease.release') return false;
  const owner = typeof message.opToken === 'string' ? tokens.get(message.opToken) : socket;
  const context = owner ? operations.get(owner) : undefined;
  const signal = owner ? controllers.get(owner)?.signal : undefined;
  const params = isJsonObject(message.params) ? message.params : {};
  const respond = (answer: Record<string, unknown>) => {
    if (socket.destroyed) return;
    if (operations.has(socket)) socket.write(`${JSON.stringify(answer)}\n`);
    else socket.end(`${JSON.stringify(answer)}\n`);
  };
  if (!owner || !context || !signal) {
    respond({ op: 'error', code: 'lease', message: 'the operation is no longer admitted' });
  } else if (op === 'lease.prepare') {
    let sameRoot = false;
    try {
      sameRoot = typeof params.root === 'string' && realpathSync(params.root) === realpathSync(context.workspace);
    } catch {}
    if (
      !sameRoot ||
      (params.platform !== 'ios' && params.platform !== 'android') ||
      typeof params.slot !== 'string' ||
      typeof params.id !== 'string' ||
      typeof params.idLabel !== 'string' ||
      typeof params.waitSeconds !== 'number' ||
      !Number.isFinite(params.waitSeconds) ||
      params.waitSeconds < 0 ||
      typeof params.noWait !== 'boolean' ||
      typeof params.installBoundMs !== 'number' ||
      !Number.isFinite(params.installBoundMs) ||
      params.installBoundMs < 0 ||
      (params.deviceName !== null && typeof params.deviceName !== 'string') ||
      (params.appId !== null && typeof params.appId !== 'string')
    ) {
      respond({ op: 'error', code: 'lease', message: 'invalid device ticket request' });
    } else {
      const ticket = tickets.prepare(
        owner,
        {
          root: context.workspace,
          platform: params.platform,
          slot: params.slot,
          id: params.id,
          idLabel: params.idLabel,
          waitSeconds: params.waitSeconds,
          noWait: params.noWait,
          installBoundMs: params.installBoundMs,
          deviceName: params.deviceName,
          appId: params.appId,
        },
        signal,
      );
      respond({ op: 'lease.prepared', ticket });
    }
  } else if (typeof params.ticket !== 'string') {
    respond({ op: 'error', code: 'lease', message: 'invalid device ticket' });
  } else if (op === 'lease.release') {
    tickets.release(params.ticket, owner);
    respond({ op: 'lease.released' });
  } else {
    const ticket = params.ticket;
    void traceInvocation(context, 'stimd.lease.acquire', () =>
      withInvocation(context, signal, () =>
        tickets.acquire(ticket, owner, (progress) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ op: 'progress', line: progress })}\n`);
        }),
      ),
    ).then(
      (result) => respond({ op: 'lease.acquired', result }),
      (error: unknown) =>
        respond({
          op: 'error',
          code: 'lease',
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }
  return true;
}
