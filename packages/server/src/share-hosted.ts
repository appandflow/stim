import { isJsonObject, type StatusPayload } from '@stim-cli/core/state';
import type { AuditRecord } from './actions.ts';
import type { Controller, InputCommand, SessionTarget } from './control.ts';
import type { FrameHint } from './frame-helper.ts';
import type { Frame, FrameListener } from './frames.ts';
import type { HostConnections, Upstream } from './hosted-relay.ts';
import type { ControlBeginParams, ErrorCode, ProtocolError, ServerMessage } from './protocol.ts';

/** The device-host session a workspace slot runs in, as `stim status` reports it. */
export interface HostedTarget {
  machine: string;
  session: string;
  /** The session reached ready, so its device exists on the host. */
  ready: boolean;
}

type Refusal = { code: ErrorCode; message: string };
type ShareListener = Pick<FrameListener, 'frame' | 'delayed' | 'failed'>;
type Lease = Awaited<ReturnType<HostConnections['acquire']>>;
type PlatformSlot = { platform: 'ios' | 'android'; slot?: string };

/** The frames of a shared device and the input to it, wherever the device runs. */
export interface ShareSource {
  /** Starts capture for the first listener; the returned function stops it with the last. */
  subscribe: (listener: ShareListener, hint: FrameHint) => () => void;
  begin: (
    owner: Controller,
    target: ControlBeginParams,
    workspace: string,
    allowed: () => boolean,
  ) => Promise<{ session: string } | Refusal>;
  targetOf: (owner: Controller, session: string) => SessionTarget | null;
  /** `method` and `params` are the already validated wire form of `command`. */
  input: (
    owner: Controller,
    session: string,
    method: string,
    params: Record<string, unknown>,
    command: InputCommand,
  ) => Promise<Refusal | null | object>;
  endFor: (owner: Controller, message: string) => void;
  close: () => void;
}

/** The hosted session of the share's slot in a status payload; null for a physical device or a local one. */
export function hostedOf(
  payload: StatusPayload,
  target: PlatformSlot & { workspace: string; physical?: boolean },
): HostedTarget | null {
  if (target.physical || !Array.isArray(payload.environments)) return null;
  const environment = payload.environments.find((candidate) => candidate.path === target.workspace);
  const slot = target.slot ?? 'default';
  const devices = slot === 'default' ? environment : environment?.slots?.find((candidate) => candidate.slot === slot);
  const host = devices?.[target.platform]?.host;
  return host ? { machine: host.machine, session: host.session, ready: host.device !== null } : null;
}

/**
 * Frames and input for a simulator or emulator a host Mac runs for this machine, over the client's own authenticated
 * device-host connection. One host subscription serves every viewer, and none exists while nobody watches.
 */
export class HostedShareSource implements ShareSource {
  private readonly hosts: Pick<HostConnections, 'acquire'>;
  private readonly host: HostedTarget;
  private readonly target: Required<PlatformSlot>;
  private readonly audit: (record: AuditRecord) => void;
  private readonly listeners = new Set<ShareListener>();
  private frames: { lease: Lease; subscription: string; unroute: () => void } | null = null;
  private opening = false;
  private latest: Frame | null = null;
  private control: {
    lease: Lease;
    session: string;
    unroute: () => void;
    postures: SessionTarget['postures'];
    owner: Controller;
    workspace: string;
    startedAt: number;
  } | null = null;
  private closed = false;

  constructor(
    hosts: Pick<HostConnections, 'acquire'>,
    host: HostedTarget,
    target: PlatformSlot,
    audit: (record: AuditRecord) => void,
  ) {
    this.hosts = hosts;
    this.host = host;
    this.target = { platform: target.platform, slot: target.slot ?? 'default' };
    this.audit = audit;
  }

  subscribe(listener: ShareListener, hint: FrameHint): () => void {
    this.listeners.add(listener);
    if (this.latest) listener.frame(this.latest);
    if (!this.frames && !this.opening) void this.openFrames(hint);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopFrames();
    };
  }

  private async openFrames(hint: FrameHint): Promise<void> {
    this.opening = true;
    let lease: Lease | undefined;
    let subscription: string | undefined;
    try {
      lease = await this.hosts.acquire(this.host);
      const reply = await lease.connection.request('device-host.frames.subscribe', {
        session: this.host.session,
        fps: hint.fps,
        maxEdge: hint.maxEdge,
      });
      if ('error' in reply) throw new Error(reply.error.message);
      if (!isJsonObject(reply.result) || typeof reply.result.subscription !== 'string')
        throw new Error('the host sent no subscription');
      subscription = reply.result.subscription;
      const unroute = lease.connection.route(`s:${subscription}`, {
        event: (event) => this.frameEvent(event),
        closed: (error) => this.fail(error.message),
      });
      this.frames = { lease, subscription, unroute };
      this.opening = false;
      if (this.closed || !this.listeners.size) this.stopFrames();
    } catch (cause) {
      this.opening = false;
      if (lease && subscription) release(lease, 'device-host.unsubscribe', { subscription });
      else lease?.release();
      this.fail(reason(cause));
    }
  }

  private frameEvent(event: Record<string, unknown> | Buffer): void {
    if (Buffer.isBuffer(event)) return;
    if (event.event === 'frame') {
      if (typeof event.data !== 'string') return this.fail('the host sent an invalid JPEG frame');
      const latest: Frame = {
        width: Number(event.width),
        height: Number(event.height),
        capturedAt: String(event.capturedAt),
        data: event.data,
      };
      this.latest = latest;
      for (const listener of this.listeners) listener.frame(latest);
    } else if (event.event === 'frame-delayed') {
      for (const listener of this.listeners) listener.delayed?.(event.delayed === true);
    } else if (event.event === 'error') {
      this.fail(isJsonObject(event.error) ? String(event.error.message) : 'host frames failed');
    }
  }

  private stopFrames(): void {
    const frames = this.frames;
    this.frames = null;
    this.latest = null;
    if (!frames) return;
    frames.unroute();
    release(frames.lease, 'device-host.unsubscribe', { subscription: frames.subscription });
  }

  private fail(message: string): void {
    const frames = this.frames;
    this.frames = null;
    this.latest = null;
    if (frames) {
      frames.unroute();
      frames.lease.release();
    }
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener.failed?.(`${this.host.machine}: ${message}`);
  }

  async begin(
    owner: Controller,
    _target: ControlBeginParams,
    workspace: string,
    allowed: () => boolean,
  ): Promise<{ session: string } | Refusal> {
    const record = (outcome: { ok: boolean; error?: ProtocolError }) =>
      this.audit({
        at: new Date().toISOString(),
        workspace,
        device: owner.device,
        platform: this.target.platform,
        slot: this.target.slot,
        action: 'control.begin',
        ...outcome,
      });
    let lease: Lease | undefined;
    let hostSession: string | undefined;
    try {
      if (this.closed || this.control) throw new Error('this share already controls the device');
      lease = await this.hosts.acquire(this.host);
      const reply = await lease.connection.request('device-host.control.begin', {
        session: this.host.session,
        takeOver: false,
      });
      if ('error' in reply) {
        lease.release();
        record({ ok: false, error: reply.error });
        return reply.error;
      }
      if (!isJsonObject(reply.result) || typeof reply.result.session !== 'string')
        throw new Error('the host sent no control session');
      const session = reply.result.session;
      hostSession = session;
      if (this.closed || !allowed()) throw new Error('local control access ended');
      const postures = Array.isArray(reply.result.postures) ? (reply.result.postures as SessionTarget['postures']) : [];
      const connection = lease.connection;
      const ended = (reason: string, message: string, host: 'ended' | 'end') => {
        owner.send({
          event: 'control-ended',
          session,
          ...this.target,
          reason,
          message,
        } as unknown as ServerMessage);
        this.endControl(reason, message, host);
      };
      const unroute = connection.route(`c:${session}`, {
        event: (event) => {
          if (!Buffer.isBuffer(event) && event.event === 'control-ended')
            ended(String(event.reason), String(event.message), 'ended');
        },
        closed: (error) => ended('failed', `${this.host.machine}: ${error.message}`, 'ended'),
      });
      this.control = { lease, session, unroute, postures, owner, workspace, startedAt: Date.now() };
      record({ ok: true });
      return { session };
    } catch (cause) {
      const message = `${this.host.machine}: ${reason(cause)}`;
      if (lease && hostSession) release(lease, 'device-host.control.end', { session: hostSession });
      else lease?.release();
      const error: ProtocolError = { code: 'action-failed', message };
      record({ ok: false, error });
      return error;
    }
  }

  targetOf(_owner: Controller, session: string): SessionTarget | null {
    if (this.control?.session !== session) return null;
    return { ...this.target, postures: this.control.postures };
  }

  async input(
    _owner: Controller,
    session: string,
    method: string,
    params: Record<string, unknown>,
    _command: InputCommand,
  ): Promise<Refusal | null> {
    const control = this.control;
    if (control?.session !== session) return { code: 'action-failed', message: 'The hosted control session ended.' };
    try {
      const reply = await control.lease.connection.request(`device-host.${method}`, { ...params, session });
      return 'error' in reply ? reply.error : null;
    } catch (cause) {
      return { code: 'action-failed', message: `${this.host.machine}: ${reason(cause)}` };
    }
  }

  endFor(_owner: Controller, message: string): void {
    this.endControl(null, message, 'end');
  }

  private endControl(reason: string | null, message: string, host: 'ended' | 'end'): void {
    const control = this.control;
    if (!control) return;
    this.control = null;
    control.unroute();
    this.audit({
      at: new Date().toISOString(),
      device: control.owner.device,
      workspace: control.workspace,
      platform: this.target.platform,
      slot: this.target.slot,
      action: 'control.end',
      ok: true,
      durationMs: Date.now() - control.startedAt,
      reason: `${reason ?? 'ended'}: ${message}`,
    });
    if (host === 'ended') control.lease.release();
    else release(control.lease, 'device-host.control.end', { session: control.session });
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.stopFrames();
    this.endControl(null, 'The share ended.', 'end');
  }
}

function release(lease: Lease, method: string, params: unknown): void {
  const connection: Upstream = lease.connection;
  void connection
    .request(method, params)
    .catch(() => {})
    .finally(lease.release);
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
