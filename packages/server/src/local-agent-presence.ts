import {
  agentActionGesture,
  agentActionTarget,
  readAgentSnapshot,
  type AgentSnapshotTree,
  type NdjsonRecord,
} from '@stim-cli/core/state';
import type { ScreenSize } from './device-screen.ts';
import { AGENT_COMMAND, presenceKey, type PresenceHub } from './presence.ts';
import type { PresenceGesture } from './protocol.ts';

const FRESH_MS = 5000;
const PAIR_MS = 10_000;
const MAX_PENDING = 16;
const SWEEP_AT = 32;

type Source = 'wrapper' | 'records';

interface Follow {
  keys: Map<string, number>;
  stop: () => void;
  screens: Map<string, Promise<ScreenSize | null>>;
}

export interface LocalAgentPresenceOptions {
  hub: Pick<PresenceHub, 'subscribe' | 'agent'>;
  follow: (workspace: string, onRecord: (record: NdjsonRecord) => void, signal: AbortSignal) => Promise<() => void>;
  screen: (platform: 'ios' | 'android', device: string) => Promise<ScreenSize | null>;
  tree?: (workspace: string, session: string) => AgentSnapshotTree | null;
  now?: () => number;
}

function signature(key: string, gesture: PresenceGesture): string {
  return JSON.stringify([key, gesture.kind, gesture.from, gesture.to ?? null]);
}

/** The workspace of a device key that an owned simulator or emulator has; null for a physical device or another key. */
function workspaceOf(key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {}
  return Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[3] !== true ? parsed[0] : null;
}

/**
 * Shows what agents do on local devices that call agent-device directly, from the actions it recorded: while a
 * consumer follows a device's presence, its workspace's agent log is followed and each recorded action becomes the
 * agent's gesture, a moment after it finished. `stim agent-device` shows the same actions sooner; the two copies of
 * one gesture are paired so that it draws once.
 */
export class LocalAgentPresence {
  private readonly options: LocalAgentPresenceOptions;
  private readonly follows = new Map<string, Follow>();
  private readonly pending = new Map<string, { source: Source; at: number }[]>();

  constructor(options: LocalAgentPresenceOptions) {
    this.options = options;
  }

  /** Subscribes to a device's presence, and follows its agent actions while the subscription lasts. */
  subscribe(key: string, listener: Parameters<PresenceHub['subscribe']>[1]): () => void {
    const stop = this.options.hub.subscribe(key, listener);
    const unfollow = this.follow(key);
    return () => {
      stop();
      unfollow();
    };
  }

  /** What `stim agent-device` published for a device: its gesture is dropped when the records already showed it. */
  published(key: string, command: string, phase: 'start' | 'end', gesture: PresenceGesture | undefined): void {
    const repeated = gesture !== undefined && this.followed(key) && this.paired(key, 'wrapper', gesture);
    this.options.hub.agent(key, command, phase, repeated ? undefined : gesture);
  }

  private followed(key: string): boolean {
    const workspace = workspaceOf(key);
    return workspace !== null && this.follows.get(workspace)?.keys.has(key) === true;
  }

  private paired(key: string, source: Source, gesture: PresenceGesture): boolean {
    const now = (this.options.now ?? Date.now)();
    if (this.pending.size >= SWEEP_AT)
      for (const [id, entries] of this.pending)
        if (entries.every((entry) => now - entry.at >= PAIR_MS)) this.pending.delete(id);
    const id = signature(key, gesture);
    const waiting = (this.pending.get(id) ?? []).filter((entry) => now - entry.at < PAIR_MS);
    const other = waiting.findIndex((entry) => entry.source !== source);
    if (other >= 0) waiting.splice(other, 1);
    else waiting.push({ source, at: now });
    if (waiting.length) this.pending.set(id, waiting.slice(-MAX_PENDING));
    else this.pending.delete(id);
    return other >= 0;
  }

  private follow(key: string): () => void {
    const workspace = workspaceOf(key);
    if (workspace === null) return () => {};
    let follow = this.follows.get(workspace);
    if (!follow) {
      const abort = new AbortController();
      const entry: Follow = { keys: new Map(), stop: () => abort.abort(), screens: new Map() };
      follow = entry;
      this.follows.set(workspace, entry);
      void (async () => {
        try {
          const stop = await this.options.follow(
            workspace,
            (record) => this.record(workspace, entry, record),
            abort.signal,
          );
          if (abort.signal.aborted) stop();
        } catch {
          if (this.follows.get(workspace) === entry) this.follows.delete(workspace);
        }
      })();
    }
    const held = follow;
    held.keys.set(key, (held.keys.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (held.keys.get(key) ?? 1) - 1;
      if (left > 0) return void held.keys.set(key, left);
      held.keys.delete(key);
      if (held.keys.size) return;
      held.stop();
      if (this.follows.get(workspace) === held) this.follows.delete(workspace);
    };
  }

  private record(workspace: string, follow: Follow, record: NdjsonRecord): void {
    const { command, platform, slot, session, deviceId, ts, details } = record;
    if (record.event !== 'agent_action' || typeof command !== 'string' || !AGENT_COMMAND.test(command)) return;
    if (platform !== 'ios' && platform !== 'android') return;
    const key = presenceKey(workspace, platform, typeof slot === 'string' ? slot : 'default', false);
    if (!follow.keys.has(key)) return;
    const now = (this.options.now ?? Date.now)();
    if (typeof ts !== 'number' || now - ts > FRESH_MS) return;
    const tree = typeof session === 'string' ? (this.options.tree ?? readAgentSnapshot)(workspace, session) : null;
    void (async () => {
      try {
        const screen = await this.screen(
          follow,
          platform,
          typeof deviceId === 'string' && tree?.viewport == null ? deviceId : null,
        );
        const gesture = agentActionGesture(details, tree, agentActionTarget(details), screen);
        if (gesture && this.paired(key, 'records', gesture)) return;
        this.options.hub.agent(key, command, 'end', gesture ?? undefined);
      } catch {}
    })();
  }

  private screen(follow: Follow, platform: 'ios' | 'android', device: string | null): Promise<ScreenSize | null> {
    if (device === null) return Promise.resolve(null);
    const id = `${platform}:${device}`;
    let screen = follow.screens.get(id);
    if (!screen) {
      const measured: Promise<ScreenSize | null> = this.options.screen(platform, device).then(
        (size) => {
          if (size === null && follow.screens.get(id) === measured) follow.screens.delete(id);
          return size;
        },
        () => {
          if (follow.screens.get(id) === measured) follow.screens.delete(id);
          return null;
        },
      );
      screen = measured;
      follow.screens.set(id, screen);
    }
    return screen;
  }
}
