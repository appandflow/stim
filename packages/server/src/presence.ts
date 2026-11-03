import { isJsonObject } from '@stim-cli/core/state';
import type {
  PresenceGesture,
  PresenceParticipant,
  PresencePoint,
  PresencePublishParams,
  PresenceRect,
  PresenceTouch,
} from './protocol.ts';

/** How long an agent stays on a device's roster after its last command ended. */
export const AGENT_LINGER_MS = 5000;
/** How long a started command keeps the agent on the roster when its end never arrives. */
const AGENT_START_MS = 10 * 60_000;
const AGENT_COLOR = 1;
const AGENT_PREFIX = 'Agent \u00b7 ';
/** Moves reach subscribers at most 30 times a second per device; `down` and `up` go at once. */
export const MOVE_FLUSH_MS = 33;

type Listener = (participants: PresenceParticipant[]) => void;

interface Device {
  listeners: Set<Listener>;
  agent: PresenceParticipant | null;
  leave: NodeJS.Timeout | null;
  /** The humans on the device, by participant id, without their touches. */
  people: Map<string, PresenceParticipant>;
  /** The latest `move` of each participant, waiting for the next flush. */
  moves: Map<string, PresenceParticipant>;
  flush: NodeJS.Timeout | null;
}

function personOf(who: PresenceParticipant): PresenceParticipant {
  const { id, kind, name, color, viewOnly } = who;
  return { id, kind, name, color, ...(viewOnly ? { viewOnly } : {}) };
}

/** The key a host Mac publishes a hosted session's presence under. */
export function hostedPresenceKey(session: string): string {
  return JSON.stringify(['device-host', session]);
}

/** The device key presence is published under: a workspace slot's owned or physical device. */
export function presenceKey(workspace: string, platform: string, slot: string, physical: boolean): string {
  return JSON.stringify([workspace, platform, slot, physical]);
}

/**
 * Who acts on each device: the agent, published by `stim agent-device` around each agent-device command it runs, and
 * the humans whose input `ControlHub` forwards, which stay on the roster until they leave. Subscribers get the whole
 * roster at once, then each change.
 */
export class PresenceHub {
  private readonly devices = new Map<string, Device>();

  private device(key: string): Device {
    let device = this.devices.get(key);
    if (!device) {
      device = { listeners: new Set(), agent: null, leave: null, people: new Map(), moves: new Map(), flush: null };
      this.devices.set(key, device);
    }
    return device;
  }

  private forget(key: string, device: Device): void {
    if (device.listeners.size || device.agent || device.people.size) return;
    if (device.flush) clearTimeout(device.flush);
    this.devices.delete(key);
  }

  subscribe(key: string, listener: Listener): () => void {
    const device = this.device(key);
    device.listeners.add(listener);
    listener([...(device.agent ? [device.agent] : []), ...device.people.values()]);
    return () => {
      device.listeners.delete(listener);
      this.forget(key, device);
    };
  }

  /** An agent command started or ended; the agent leaves the roster {@link AGENT_LINGER_MS} after its last end. */
  agent(key: string, command: string, phase: 'start' | 'end', gesture?: PresenceGesture): void {
    const device = this.device(key);
    if (device.leave) clearTimeout(device.leave);
    device.leave = null;
    const participant: PresenceParticipant = {
      id: 'a1',
      kind: 'agent',
      name: `${AGENT_PREFIX}${command}`,
      color: AGENT_COLOR,
    };
    device.agent = participant;
    this.emit(device, [gesture ? { ...participant, gesture } : participant]);
    device.leave = setTimeout(
      () => {
        device.leave = null;
        device.agent = null;
        this.emit(device, [{ ...participant, touch: null }]);
        this.forget(key, device);
      },
      phase === 'end' ? AGENT_LINGER_MS : AGENT_START_MS,
    );
    device.leave.unref?.();
  }

  /** A human is on the device, or changed its name or color; they stay on the roster until {@link leave}. */
  join(key: string, who: PresenceParticipant): void {
    const device = this.device(key);
    const person = personOf(who);
    device.people.set(who.id, person);
    this.flushMoves(device);
    this.emit(device, [person]);
  }

  /** A human's finger moved: `down` and `up` reach subscribers at once, a `move` within {@link MOVE_FLUSH_MS}. */
  touch(key: string, who: PresenceParticipant, touch: PresenceTouch): void {
    const device = this.device(key);
    const person = personOf(who);
    device.people.set(who.id, person);
    if (touch.phase === 'move') {
      device.moves.set(who.id, { ...person, touch });
      device.flush ??= setTimeout(() => this.flushMoves(device), MOVE_FLUSH_MS);
      device.flush.unref?.();
      return;
    }
    this.flushMoves(device);
    this.emit(device, [{ ...person, touch }]);
  }

  leave(key: string, id: string): void {
    const device = this.devices.get(key);
    const person = device?.people.get(id);
    if (!device || !person) return;
    this.flushMoves(device);
    device.people.delete(id);
    this.emit(device, [{ ...person, touch: null }]);
    this.forget(key, device);
  }

  close(): void {
    for (const device of this.devices.values()) {
      if (device.leave) clearTimeout(device.leave);
      if (device.flush) clearTimeout(device.flush);
    }
    this.devices.clear();
  }

  private flushMoves(device: Device): void {
    if (device.flush) clearTimeout(device.flush);
    device.flush = null;
    if (!device.moves.size) return;
    const moves = [...device.moves.values()];
    device.moves.clear();
    this.emit(device, moves);
  }

  private emit(device: Device, participants: PresenceParticipant[]): void {
    for (const listener of device.listeners) listener(participants);
  }
}

const SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The shape of an agent-device command name. */
export const AGENT_COMMAND: RegExp = /^[a-z][a-z0-9-]{0,31}$/;

function fraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function point(value: unknown): PresencePoint | null {
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== 'x' && key !== 'y')) return null;
  return fraction(value.x) && fraction(value.y) ? { x: value.x, y: value.y } : null;
}

function gestureOf(value: unknown): PresenceGesture | null {
  if (!isJsonObject(value)) return null;
  const { kind, from, to, durationMs, target, ...rest } = value;
  if (Object.keys(rest).length || (kind !== 'tap' && kind !== 'swipe')) return null;
  const start = point(from);
  const end = to === undefined ? undefined : point(to);
  if (!start || end === null || !fraction(durationMs) || durationMs < 0) return null;
  let rect: PresenceRect | undefined;
  if (target !== undefined) {
    if (!isJsonObject(target)) return null;
    const { x, y, width, height, ...extra } = target;
    if (Object.keys(extra).length || !fraction(x) || !fraction(y) || !fraction(width) || !fraction(height)) return null;
    if (width < 0 || height < 0) return null;
    rect = { x, y, width, height };
  }
  return { kind, from: start, ...(end ? { to: end } : {}), durationMs, ...(rect ? { target: rect } : {}) };
}

/** Validates `presence.publish` params; returns why they are refused. */
export function parsePresencePublish(params: unknown): PresencePublishParams | string {
  if (!isJsonObject(params)) return 'presence.publish needs params.';
  const { workspace, platform, slot, physical, command, phase, gesture, ...rest } = params;
  if (Object.keys(rest).length) return `presence.publish does not take ${Object.keys(rest).join(', ')}.`;
  if (typeof workspace !== 'string' || !workspace) return 'params.workspace must be an environment path.';
  if (platform !== 'ios' && platform !== 'android') return 'params.platform must be ios or android.';
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT.test(slot)))
    return 'params.slot must be 1-64 letters, digits, underscores or hyphens.';
  if (physical !== undefined && typeof physical !== 'boolean') return 'params.physical must be true or false.';
  if (typeof command !== 'string' || !AGENT_COMMAND.test(command))
    return 'params.command must be an agent-device command.';
  if (phase !== 'start' && phase !== 'end') return 'params.phase must be start or end.';
  const parsed = gesture === undefined ? undefined : gestureOf(gesture);
  if (parsed === null) return 'params.gesture is not a presence gesture.';
  return {
    workspace,
    platform,
    ...(slot !== undefined ? { slot } : {}),
    ...(physical !== undefined ? { physical } : {}),
    command,
    phase,
    ...(parsed ? { gesture: parsed } : {}),
  };
}

/**
 * The agent actions in a `presence` event a host Mac sent for a hosted session. It is another machine's data: only
 * the agent participant, named for an agent-device command, with a valid gesture, is taken; anything else is dropped.
 */
export function parseHostedAgent(participants: unknown): { command: string; gesture?: PresenceGesture }[] {
  if (!Array.isArray(participants)) return [];
  return participants.flatMap((participant) => {
    if (!isJsonObject(participant) || participant.kind !== 'agent' || participant.touch === null) return [];
    const { name, gesture } = participant;
    if (typeof name !== 'string' || !name.startsWith(AGENT_PREFIX)) return [];
    const command = name.slice(AGENT_PREFIX.length);
    const parsed = gesture === undefined ? undefined : gestureOf(gesture);
    if (!AGENT_COMMAND.test(command) || parsed === null) return [];
    return [{ command, ...(parsed ? { gesture: parsed } : {}) }];
  });
}
