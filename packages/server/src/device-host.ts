import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '@stim-cli/core/process-identity';
import {
  assertHostedDeviceLedger,
  deviceHostArea,
  deviceHostRoot,
  getConcurrencyLimits,
  isJsonObject,
  parseHostedDevice,
  parseHostedRequest,
  readHostedDevice,
  readHostedSessions,
  type HostedDeviceRequest,
  type HostedDeviceSession,
} from '@stim-cli/core/state';
import { writeJson } from './registry.ts';
import type { ProtocolError } from './protocol.ts';

export interface DeviceHostLimits {
  prepareMs: number;
  stopMs: number;
  killGraceMs: number;
}

interface WorkerRun {
  done: Promise<{ value: unknown; settled: boolean; notice?: string }>;
  cancel: () => void;
}

interface OwnedSession {
  claim: ClaimHandle;
  run?: WorkerRun;
  stopping?: Promise<void>;
}

type Answer = { result: HostedDeviceSession } | { error: ProtocolError };
const refused = (code: ProtocolError['code'], message: string): Answer => ({ error: { code, message } });

/** Owns hosted reservations, not build jobs or viewer connections. Native work runs in the packaged CLI child. */
export class DeviceHost {
  private readonly owned = new Map<string, OwnedSession>();
  private readonly revoked = new Set<string>();
  private closed = false;
  private readonly limits: DeviceHostLimits;

  private readonly options: {
    worker: string;
    env: NodeJS.ProcessEnv;
    allowed: (client: string) => boolean;
    limits?: Partial<DeviceHostLimits>;
  };

  constructor(options: {
    worker: string;
    env: NodeJS.ProcessEnv;
    allowed: (client: string) => boolean;
    limits?: Partial<DeviceHostLimits>;
  }) {
    this.options = options;
    this.limits = { prepareMs: 5 * 60_000, stopMs: 90_000, killGraceMs: 5000, ...options.limits };
  }

  private transaction<T>(fn: (records: HostedDeviceSession[]) => T): T {
    const root = deviceHostRoot();
    return withDirLock(
      `${root}.lock`,
      () => {
        if (!existsSync(root)) {
          readHostedSessions();
          mkdirSync(root, { recursive: true, mode: 0o700 });
          writeJson(join(root, 'sessions.json'), { version: 1, sessions: [] });
        }
        const records = readHostedSessions();
        const result = fn(records);
        writeJson(join(root, 'sessions.json'), { version: 1, sessions: records });
        return result;
      },
      { ensureParent: () => mkdirSync(join(root, '..'), { recursive: true, mode: 0o700 }) },
    );
  }

  private change(id: string, update: (record: HostedDeviceSession) => void): void {
    this.transaction((records) => {
      const record = records.find((each) => each.id === id);
      if (!record) throw new Error('Hosted session journal no longer contains this reservation.');
      update(record);
    });
  }

  private acquire(record: HostedDeviceSession): OwnedSession {
    const existing = this.owned.get(record.id);
    if (existing) return existing;
    const attempt = tryAcquireClaim({
      root: join(deviceHostRoot(), `${record.id}.claims`),
      mode: 'exclusive',
      label: 'hosted device session',
      details: { session: record.id, client: record.client },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      throw new Error(`Hosted session is held by another process: ${join(deviceHostRoot(), `${record.id}.claims`)}`);
    const owned = { claim: attempt.acquired };
    this.owned.set(record.id, owned);
    return owned;
  }

  reserve(client: string, params: unknown): Answer {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    const request = parseHostedRequest(params);
    if (!request)
      return refused('bad-request', 'reserve needs an iOS workspace, slot, attempt and valid optional selectors.');
    let start: HostedDeviceSession | null = null;
    try {
      const result = this.transaction((records) => {
        const retry = records.find((record) => record.client === client && record.attempt === request.attempt);
        if (retry) {
          if (!sameRequest(retry, request)) throw new Error('This attempt already names a different reservation.');
          return this.observed(retry);
        }
        const occupied = records.find(
          (record) =>
            record.client === client &&
            record.workspace === request.workspace &&
            record.slot === request.slot &&
            record.state !== 'stopped',
        );
        if (occupied)
          throw new Error(`This workspace slot already has session ${occupied.id}; attach or stop it first.`);
        const max = getConcurrencyLimits({ env: this.options.env }).maxDevices;
        if (max > 0 && records.filter((record) => record.state !== 'stopped').length >= max)
          throw new Error('All configured hosted device reservations are occupied, including unresolved sessions.');
        const record: HostedDeviceSession = {
          ...request,
          id: randomUUID(),
          client,
          state: 'preparing',
          device: null,
          createdAt: new Date().toISOString(),
        };
        this.acquire(record);
        records.push(record);
        start = record;
        return record;
      });
      if (start) void this.prepare(start).catch((error: unknown) => this.failed(start!.id, error));
      return { result };
    } catch (error) {
      return refused('device-busy', (error as Error).message);
    }
  }

  private observed(record: HostedDeviceSession): HostedDeviceSession {
    if (record.state !== 'stopped' && !this.owned.has(record.id))
      return {
        ...record,
        state: 'unknown',
        notice:
          'The previous session owner is not attached to this server. Explicit stop must reconcile the retained device before another reservation.',
      };
    return { ...record };
  }

  attach(client: string, params: unknown): Answer {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || (typeof params.session !== 'string' && typeof params.attempt !== 'string'))
      return refused('bad-request', 'attach needs session or attempt.');
    try {
      const record = readHostedSessions().find(
        (each) =>
          each.client === client &&
          (typeof params.session === 'string' ? each.id === params.session : each.attempt === params.attempt),
      );
      return record
        ? { result: this.observed(record) }
        : refused('unknown-session', 'This client has no such hosted session.');
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  stop(client: string, params: unknown): Answer {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || typeof params.session !== 'string')
      return refused('bad-request', 'stop needs session.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      this.beginStop(record);
      return { result: { ...record, state: record.state === 'stopped' ? 'stopped' : 'stopping' } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  private async prepare(record: HostedDeviceSession): Promise<void> {
    const owned = this.owned.get(record.id)!;
    if (!this.options.allowed(record.client) || this.closed) {
      this.beginStop(record);
      return;
    }
    const run = this.run(record, owned, 'prepare');
    owned.run = run;
    const outcome = await run.done;
    if (owned.stopping) return;
    const value = outcome.value;
    const device = isJsonObject(value) ? parseHostedDevice(value.device) : null;
    if (outcome.settled && isJsonObject(value) && value.state === 'ready' && device) {
      const home = join(deviceHostArea(record.id), 'home');
      assertHostedDeviceLedger(home, device.udid);
      if (readHostedDevice(home).udid !== device.udid)
        throw new Error('The worker result does not match its persisted device.');
    }
    this.change(record.id, (current) => {
      current.device = device;
      current.state =
        !outcome.notice && outcome.settled && isJsonObject(value) && value.state === 'ready' && device
          ? 'ready'
          : !outcome.notice && outcome.settled && isJsonObject(value) && value.state === 'stopped'
            ? 'stopped'
            : 'unknown';
      if (current.state === 'unknown')
        current.notice =
          outcome.notice ??
          (isJsonObject(value) && typeof value.notice === 'string'
            ? value.notice
            : 'Preparation outcome is unresolved; stop this session before retrying.');
      else if (isJsonObject(value) && typeof value.notice === 'string') current.notice = value.notice;
      if (current.state === 'stopped') this.release(record.id, owned);
    });
    if (!this.options.allowed(record.client) || this.closed)
      this.beginStop(readHostedSessions().find((each) => each.id === record.id)!);
  }

  private beginStop(record: HostedDeviceSession): void {
    if (record.state === 'stopped') return;
    const owned = this.acquire(record);
    if (owned.stopping) return;
    this.change(record.id, (current) => {
      current.state = 'stopping';
    });
    owned.stopping = this.finishStop(record, owned)
      .catch((error: unknown) => this.failed(record.id, error))
      .finally(() => {
        delete owned.stopping;
      });
  }

  private async finishStop(record: HostedDeviceSession, owned: OwnedSession): Promise<void> {
    if (owned.run) {
      owned.run.cancel();
      if (!(await owned.run.done).settled)
        throw new Error('The prior worker group is unresolved. Its claim and device were retained.');
    }
    const home = join(deviceHostArea(record.id), 'home');
    const device = readHostedDevice(home);
    if (record.device && record.device.udid !== device.udid)
      throw new Error('The device record no longer matches this session.');
    this.change(record.id, (current) => {
      current.device = device;
    });
    const run = this.run(record, owned, 'stop');
    owned.run = run;
    const outcome = await run.done;
    const stopped =
      !outcome.notice &&
      outcome.settled &&
      isJsonObject(outcome.value) &&
      outcome.value.state === 'stopped' &&
      parseHostedDevice(outcome.value.device)?.udid === device.udid;
    this.change(record.id, (current) => {
      current.state = stopped ? 'stopped' : 'unknown';
      if (stopped) delete current.notice;
      else
        current.notice =
          outcome.notice ??
          (isJsonObject(outcome.value) && typeof outcome.value.notice === 'string'
            ? outcome.value.notice
            : 'Shutdown could not be verified. The reservation and device records were retained.');
    });
    if (stopped) this.release(record.id, owned);
  }

  private failed(id: string, error: unknown): void {
    try {
      this.change(id, (record) => {
        record.state = 'unknown';
        record.notice = (error as Error).message;
      });
    } catch (journalError) {
      process.stderr.write(`Hosted session ${id} remains unresolved: ${(journalError as Error).message}\n`);
    }
  }

  private release(id: string, owned: OwnedSession): void {
    if (releaseClaim(owned.claim)) this.owned.delete(id);
  }

  revoke(): void {
    try {
      for (const record of readHostedSessions()) {
        if (record.state === 'stopped' || this.options.allowed(record.client) || this.revoked.has(record.id)) continue;
        this.revoked.add(record.id);
        try {
          this.beginStop(record);
        } catch (error) {
          this.failed(record.id, error);
        }
      }
    } catch (error) {
      for (const owned of this.owned.values()) owned.run?.cancel();
      process.stderr.write(`Hosted device revocation could not read its journal: ${(error as Error).message}\n`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      for (const record of readHostedSessions()) {
        if (!this.owned.has(record.id)) continue;
        try {
          this.beginStop(record);
        } catch (error) {
          this.failed(record.id, error);
        }
      }
    } catch {
      for (const owned of this.owned.values()) owned.run?.cancel();
    }
    await Promise.all([...this.owned.values()].map((owned) => owned.stopping ?? owned.run?.done));
  }

  private run(record: HostedDeviceSession, owned: OwnedSession, mode: 'prepare' | 'stop'): WorkerRun {
    const home = join(deviceHostArea(record.id), 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    markClaimChildPending(owned.claim);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.options.worker], {
        cwd: home,
        env: { ...this.options.env, STIM_HOME: home },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      clearClaimChild(owned.claim);
      throw error;
    }
    let identity: ProcessRecord | null = null;
    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderr = '';
    let notice: string | undefined;
    let finished = false;
    let cancelling = false;
    let killTimer: NodeJS.Timeout | undefined;
    let finishTimer: NodeJS.Timeout | undefined;
    let settle!: (result: { value: unknown; settled: boolean; notice?: string }) => void;
    const done = new Promise<{ value: unknown; settled: boolean; notice?: string }>((resolve) => {
      settle = resolve;
    });
    const finish = (closed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      const settled = closed && (!child.pid || !processGroupAlive(child.pid));
      if (settled) clearClaimChild(owned.claim);
      let value: unknown = null;
      try {
        value = JSON.parse(Buffer.concat(output).toString('utf8'));
      } catch {
        notice ??= stderr.trim() || 'Hosted worker returned no valid result.';
      }
      if (!settled) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
      }
      settle({ value, settled, ...(notice ? { notice } : {}) });
    };
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid || !identity || inspectProcessIdentity(identity) !== 'same') return;
      try {
        process.kill(-child.pid, name);
      } catch {}
    };
    const cancel = () => {
      if (finished || cancelling) return;
      cancelling = true;
      notice ??= 'Hosted worker was cancelled or exceeded its deadline.';
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), this.limits.killGraceMs);
      finishTimer = setTimeout(() => finish(false), this.limits.killGraceMs * 2);
    };
    const timer = setTimeout(cancel, mode === 'prepare' ? this.limits.prepareMs : this.limits.stopMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outputBytes + chunk.length > 16384) {
        notice = 'Hosted worker output exceeded its bound.';
        cancel();
      } else {
        output.push(chunk);
        outputBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.stdin?.on('error', () => cancel());
    child.once('error', (error) => {
      notice = error.message;
      finish(true);
    });
    child.once('close', (code) => {
      if (code !== 0) notice ??= stderr.trim() || `Hosted worker exited ${code}.`;
      finish(true);
    });
    const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
    if (!captured?.ok || child.pid === undefined) {
      notice = 'The worker process identity could not be captured; no native request was sent.';
      child.kill('SIGKILL');
      cancel();
    } else {
      identity = { pid: child.pid, processToken: captured.token };
      try {
        setClaimChild(owned.claim, identity);
        child.stdin?.end(JSON.stringify({ mode, deviceType: record.deviceType, runtime: record.runtime }));
      } catch (error) {
        notice = (error as Error).message;
        cancel();
      }
    }
    return { done, cancel };
  }
}

function sameRequest(a: HostedDeviceRequest, b: HostedDeviceRequest): boolean {
  return (
    a.workspace === b.workspace &&
    a.slot === b.slot &&
    a.platform === b.platform &&
    a.deviceType === b.deviceType &&
    a.runtime === b.runtime
  );
}
