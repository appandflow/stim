import { isJsonObject, type StatusPayload } from '@stim-cli/core/state';
import type { AuditRecord } from './actions.ts';
import { isExtendedDeviceKey, type Controller, type InputCommand, type SessionTarget } from './control.ts';
import type { FrameHint } from './frame-helper.ts';
import type { Frame, FrameListener } from './frames.ts';
import { GRAB_IDLE_MS, PointerGrab } from './pointer-grab.ts';
import type { PresenceHub } from './presence.ts';
import { CONGESTION_NOTICE_MS, type HostConnections, type Upstream } from './hosted-relay.ts';
import type {
  ControlBeginParams,
  DeviceFrameArtwork,
  ErrorCode,
  PresenceParticipant,
  ProtocolError,
  ServerMessage,
} from './protocol.ts';
import { accessUnitOf } from './video.ts';

/** The device-host session a workspace slot runs in, as `stim status` reports it. */
export interface HostedTarget {
  machine: string;
  session: string;
  /** The session reached ready, so its device exists on the host. */
  ready: boolean;
}

type Refusal = { code: ErrorCode; message: string };
type ShareListener = Pick<FrameListener, 'frame' | 'video' | 'delayed' | 'failed' | 'artwork'>;
type Lease = Awaited<ReturnType<HostConnections['acquire']>>;
type TouchCommand = Extract<InputCommand, { input: 'touch' }>;
type PlatformSlot = { platform: 'ios' | 'android'; slot?: string };

/** The frames of a shared device and the input to it, wherever the device runs. */
export interface ShareSource {
  /**
   * Starts capture for the first listener; the returned function stops it with the last. A listener with `video` gets
   * H.264 access units when the device streams them, and JPEG frames otherwise.
   */
  subscribe: (listener: ShareListener, hint: FrameHint) => () => void;
  /** Makes the next access unit the video listeners get a keyframe. */
  keyframe: () => void;
  /** A video listener is behind; called until its socket drains, it lowers the bitrate. */
  congested: () => void;
  begin: (
    owner: Controller,
    target: ControlBeginParams,
    workspace: string,
    allowed: () => boolean,
  ) => Promise<{ session: string } | Refusal>;
  targetOf: (owner: Controller, session: string) => SessionTarget | null;
  /**
   * `method` and `params` are the already validated wire form of `command`; `participant` is the viewer it came from.
   * A touch refused because another viewer holds the pointer comes back with `busy`, that viewer's name.
   */
  input: (
    owner: Controller,
    session: string,
    method: string,
    params: Record<string, unknown>,
    command: InputCommand,
    participant: PresenceParticipant,
  ) => Promise<Refusal | null | object>;
  /** `participant` left: lifts the pointer for it when it holds it. */
  release?: (owner: Controller, session: string, participant: PresenceParticipant) => void;
  /** Who else is on the device and where they touch; absent for a source that shows only a viewer's own touches. */
  presence?: {
    subscribe: (listener: (participants: PresenceParticipant[]) => void) => () => void;
    join: (who: PresenceParticipant) => void;
    leave: (id: string) => void;
  };
  endFor: (owner: Controller, message: string) => void;
  /** Ends only `session`, which may already be gone or replaced by a newer one. */
  end: (owner: Controller, session: string, message: string) => void;
  close: () => void;
}

function isArtwork(value: unknown): value is DeviceFrameArtwork {
  return (
    isJsonObject(value) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    isJsonObject(value.aperture) &&
    typeof value.background === 'string' &&
    typeof value.foreground === 'string'
  );
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
  readonly presence?: NonNullable<ShareSource['presence']>;
  private readonly hub?: { hub: Pick<PresenceHub, 'touch'>; key: string };
  private readonly grab = new PointerGrab<PresenceParticipant, TouchCommand>();
  private grabIdle: NodeJS.Timeout | null = null;
  private readonly hosts: Pick<HostConnections, 'acquire'>;
  private readonly host: HostedTarget;
  private readonly target: Required<PlatformSlot>;
  private readonly audit: (record: AuditRecord) => void;
  private readonly streams: Record<'jpeg' | 'h264', Stream> = { jpeg: newStream(), h264: newStream() };
  private congestedAt = -Infinity;
  private artwork: DeviceFrameArtwork | null | undefined;
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
    presence?: {
      hub: Pick<PresenceHub, 'subscribe' | 'join' | 'leave' | 'touch'>;
      /** The hub key of the shared device. */
      key: string;
      /** Brings what the host publishes about the session into the hub under `key`; returns how to stop. */
      follow: (key: string) => () => void;
    },
  ) {
    this.hosts = hosts;
    if (presence) {
      const { hub, key, follow } = presence;
      this.hub = { hub, key };
      this.presence = {
        subscribe: (listener) => {
          const unfollow = follow(key);
          const unsubscribe = hub.subscribe(key, listener);
          return () => {
            unsubscribe();
            unfollow();
          };
        },
        join: (who) => hub.join(key, who),
        leave: (id) => hub.leave(key, id),
      };
    }
    this.host = host;
    this.target = { platform: target.platform, slot: target.slot ?? 'default' };
    this.audit = audit;
  }

  subscribe(listener: ShareListener, hint: FrameHint): () => void {
    const stream = this.streams[listener.video ? 'h264' : 'jpeg'];
    stream.listeners.add(listener);
    if (stream.latest) listener.frame(stream.latest);
    if (this.artwork !== undefined) listener.artwork?.(this.artwork);
    if (!stream.open && !stream.opening) void this.openFrames(stream, hint, listener.video !== undefined);
    return () => {
      stream.listeners.delete(listener);
      if (!stream.listeners.size) this.stopFrames(stream);
    };
  }

  keyframe(): void {
    const open = this.streams.h264.open;
    if (!open) return;
    void open.lease.connection
      .request('device-host.frames.keyframe', { subscription: open.subscription })
      .catch(() => {});
  }

  congested(): void {
    const open = this.streams.h264.open;
    if (!open?.lease.connection.supports('hosted-congestion') || Date.now() - this.congestedAt < CONGESTION_NOTICE_MS)
      return;
    this.congestedAt = Date.now();
    void open.lease.connection
      .request('device-host.frames.congested', { subscription: open.subscription })
      .catch(() => {});
  }

  private async openFrames(stream: Stream, hint: FrameHint, video: boolean): Promise<void> {
    stream.opening = true;
    let lease: Lease | undefined;
    let subscription: string | undefined;
    try {
      lease = await this.hosts.acquire(this.host);
      const reply = await lease.connection.request('device-host.frames.subscribe', {
        session: this.host.session,
        fps: hint.fps,
        maxEdge: hint.maxEdge,
        ...(video ? { video: ['h264'] } : {}),
        ...([...stream.listeners].some((listener) => listener.artwork) ? { deviceFrame: true } : {}),
      });
      if ('error' in reply) throw new Error(reply.error.message);
      if (!isJsonObject(reply.result) || typeof reply.result.subscription !== 'string')
        throw new Error('the host sent no subscription');
      subscription = reply.result.subscription;
      const unroute = lease.connection.route(`s:${subscription}`, {
        event: (event) => this.frameEvent(stream, event),
        closed: (error) => this.fail(error.message),
      });
      stream.open = { lease, subscription, unroute };
      stream.opening = false;
      if (this.closed || !stream.listeners.size) this.stopFrames(stream);
    } catch (cause) {
      stream.opening = false;
      if (lease && subscription) release(lease, 'device-host.unsubscribe', { subscription });
      else lease?.release();
      this.fail(messageOf(cause));
    }
  }

  private frameEvent(stream: Stream, event: Record<string, unknown> | Buffer): void {
    if (Buffer.isBuffer(event)) {
      const unit = accessUnitOf(event);
      if (unit) for (const listener of stream.listeners) listener.video?.(unit);
      return;
    }
    if (event.event === 'frame') {
      if (typeof event.data !== 'string') return this.fail('the host sent an invalid JPEG frame');
      const latest: Frame = {
        width: Number(event.width),
        height: Number(event.height),
        capturedAt: String(event.capturedAt),
        data: event.data,
      };
      stream.latest = latest;
      for (const listener of stream.listeners) listener.frame(latest);
    } else if (event.event === 'device-frame') {
      this.artwork = isArtwork(event.artwork) ? event.artwork : null;
      for (const listener of this.listeners()) listener.artwork?.(this.artwork);
    } else if (event.event === 'frame-delayed') {
      for (const listener of stream.listeners) listener.delayed?.(event.delayed === true);
    } else if (event.event === 'error') {
      this.fail(isJsonObject(event.error) ? String(event.error.message) : 'host frames failed');
    }
  }

  private listeners(): ShareListener[] {
    return [...this.streams.jpeg.listeners, ...this.streams.h264.listeners];
  }

  private stopFrames(stream: Stream): void {
    const open = stream.open;
    stream.open = null;
    stream.latest = null;
    if (!this.streams.jpeg.open && !this.streams.h264.open) this.artwork = undefined;
    if (!open) return;
    open.unroute();
    release(open.lease, 'device-host.unsubscribe', { subscription: open.subscription });
  }

  private fail(message: string): void {
    const listeners = this.listeners();
    for (const stream of Object.values(this.streams)) {
      const open = stream.open;
      stream.open = null;
      stream.latest = null;
      stream.listeners.clear();
      if (open) {
        open.unroute();
        open.lease.release();
      }
    }
    this.artwork = undefined;
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
      const message = `${this.host.machine}: ${messageOf(cause)}`;
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
    command: InputCommand,
    participant: PresenceParticipant,
  ): Promise<Refusal | object | null> {
    const control = this.control;
    if (control?.session !== session) return { code: 'action-failed', message: 'The hosted control session ended.' };
    if (command.input === 'touch') {
      const verdict = this.grab.admit(participant, command);
      if (!verdict.admit) {
        return verdict.busy === undefined
          ? null
          : { code: 'device-busy', message: `${verdict.busy} is using the screen.`, busy: verdict.busy };
      }
      if (this.grabIdle) clearTimeout(this.grabIdle);
      this.grabIdle = command.phase === 'up' ? null : setTimeout(() => this.lift(this.grab.expire()), GRAB_IDLE_MS);
      this.grabIdle?.unref();
      this.show(participant, command);
    }
    if (method.startsWith('input.clipboard.') && !control.lease.connection.supports('device-clipboard')) {
      return {
        code: 'action-failed',
        message: `${this.host.machine} cannot set or read a clipboard: update its Stim.`,
      };
    }
    if (
      command.input === 'key' &&
      isExtendedDeviceKey(command.key, command.modifiers) &&
      !control.lease.connection.supports('device-keyboard')
    ) {
      return {
        code: 'action-failed',
        message: `${this.host.machine} takes only the arrows and Escape as keys: update its Stim.`,
      };
    }
    try {
      const reply = await control.lease.connection.request(`device-host.${method}`, { ...params, session });
      if ('error' in reply && command.input === 'touch' && reply.error.code === 'device-busy') {
        this.grab.release(participant.id);
        this.show(participant, { ...command, phase: 'up' });
        return { ...reply.error, busy: 'Host' };
      }
      if ('error' in reply) return reply.error;
      if (!isJsonObject(reply.result)) return null;
      if (method === 'input.clipboard.get') return reply.result;
      return method === 'input.clipboard.set' && reply.result.typed === true ? { typed: true } : null;
    } catch (cause) {
      return { code: 'action-failed', message: `${this.host.machine}: ${messageOf(cause)}` };
    }
  }

  release(_owner: Controller, session: string, participant: PresenceParticipant): void {
    if (this.control?.session === session) this.lift(this.grab.release(participant.id));
  }

  private show(who: PresenceParticipant, command: TouchCommand): void {
    this.hub?.hub.touch(this.hub.key, who, {
      phase: command.phase,
      x: command.x,
      y: command.y,
      ...(command.x2 !== undefined && command.y2 !== undefined ? { second: { x: command.x2, y: command.y2 } } : {}),
      at: Date.now(),
    });
  }

  /** Lets go of the device's pointer for a viewer that held it and left or went quiet. */
  private lift(lifted: { holder: PresenceParticipant; up: TouchCommand } | null): void {
    if (this.grabIdle) clearTimeout(this.grabIdle);
    this.grabIdle = null;
    const control = this.control;
    if (!lifted || !control) return;
    const { up } = lifted;
    void control.lease.connection
      .request('device-host.input.touch', {
        session: control.session,
        phase: up.phase,
        x: up.x,
        y: up.y,
        ...(up.x2 !== undefined && up.y2 !== undefined ? { x2: up.x2, y2: up.y2 } : {}),
      })
      .catch(() => {});
    this.show(lifted.holder, up);
  }

  endFor(_owner: Controller, message: string): void {
    this.endControl(null, message, 'end');
  }

  end(_owner: Controller, session: string, message: string): void {
    if (this.control?.session === session) this.endControl(null, message, 'end');
  }

  private endControl(reason: string | null, message: string, host: 'ended' | 'end'): void {
    const control = this.control;
    if (!control) return;
    this.control = null;
    if (this.grabIdle) clearTimeout(this.grabIdle);
    this.grabIdle = null;
    this.grab.expire();
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
    for (const stream of Object.values(this.streams)) {
      stream.listeners.clear();
      this.stopFrames(stream);
    }
    this.endControl(null, 'The share ended.', 'end');
  }
}

interface Stream {
  listeners: Set<ShareListener>;
  open: { lease: Lease; subscription: string; unroute: () => void } | null;
  opening: boolean;
  latest: Frame | null;
}

function newStream(): Stream {
  return { listeners: new Set(), open: null, opening: false, latest: null };
}

function release(lease: Lease, method: string, params: unknown): void {
  const connection: Upstream = lease.connection;
  void connection
    .request(method, params)
    .catch(() => {})
    .finally(lease.release);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
