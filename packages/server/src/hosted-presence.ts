import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import {
  agentActionGesture,
  createAgentActionReader,
  deviceHostArea,
  isJsonObject,
  parseAgentSnapshot,
  type AgentSnapshotTree,
  type NdjsonRecord,
} from '@stim-cli/core/state';
import { AGENT_COMMAND, hostedPresenceKey, PresenceHub } from './presence.ts';
import type { PresenceParticipant } from './protocol.ts';

/** How often a session's agent-device event logs are read while a client follows its presence. */
const POLL_MS = 250;
/** The largest agent-device answer read for a snapshot tree. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

interface Follower {
  listeners: number;
  stop: () => void;
}

/**
 * The element an agent action acted on, from the details agent-device records. A ref is kept as `@ref`; a selector
 * is redacted to `<arg>` in the record, so a single positional that is not a coordinate pair stands for one, and
 * the recorded point picks the element.
 */
function targetOf(details: unknown): string | undefined {
  if (!isJsonObject(details)) return undefined;
  const { ref, positionals, targetLabel } = details;
  if (typeof ref === 'string') return `@${ref}`;
  return Array.isArray(positionals) &&
    positionals.length === 1 &&
    typeof targetLabel === 'string' &&
    !targetLabel.startsWith('(')
    ? '<selector>'
    : undefined;
}

/**
 * What agents do on the hosted device sessions this host Mac serves: each session's agent-device records, normalized
 * with the latest snapshot its agent route answered, published to the clients that follow the session. A session is
 * followed only while a client subscribes to it, and only by the client that owns it.
 */
export class HostedPresence {
  private readonly hub = new PresenceHub();
  private readonly trees = new Map<string, AgentSnapshotTree>();
  private readonly followers = new Map<string, Follower>();
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly read: (session: string, since: number) => () => NdjsonRecord[];

  constructor(
    options: {
      pollMs?: number;
      now?: () => number;
      read?: (session: string, since: number) => () => NdjsonRecord[];
    } = {},
  ) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.now = options.now ?? Date.now;
    this.read =
      options.read ??
      ((session, since) =>
        createAgentActionReader({
          sessionsDirs: [join(deviceHostArea(session), 'agent-device', 'sessions')],
          sinceTs: since,
        }));
  }

  /** Sends `listener` the agent on `session` now, then each action of it, until the returned function is called. */
  subscribe(session: string, listener: (participants: PresenceParticipant[]) => void): () => void {
    const key = hostedPresenceKey(session);
    const unsubscribe = this.hub.subscribe(key, listener);
    let follower = this.followers.get(session);
    if (!follower) {
      const read = this.read(session, this.now());
      const timer = setInterval(() => this.publish(session, read()), this.pollMs);
      timer.unref();
      follower = { listeners: 0, stop: () => clearInterval(timer) };
      this.followers.set(session, follower);
    }
    follower.listeners++;
    const held = follower;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      unsubscribe();
      if (--held.listeners > 0) return;
      held.stop();
      if (this.followers.get(session) === held) this.followers.delete(session);
    };
  }

  private publish(session: string, records: NdjsonRecord[]): void {
    const key = hostedPresenceKey(session);
    for (const record of records) {
      const { command, details } = record;
      if (record.event !== 'agent_action' || typeof command !== 'string' || !AGENT_COMMAND.test(command)) continue;
      const gesture = agentActionGesture(details, this.trees.get(session) ?? null, targetOf(details));
      this.hub.agent(key, command, 'end', gesture ?? undefined);
    }
  }

  /** Keeps the snapshot tree of a session's agent-route answer, which a later action's point is measured in. */
  watch(session: string, response: ServerResponse): void {
    response.once('pipe', (answer: Readable) => {
      const chunks: Buffer[] = [];
      let size = 0;
      answer.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
      });
      answer.once('end', () => {
        if (size > MAX_ANSWER_BYTES) return;
        const text = Buffer.concat(chunks).toString('utf8');
        const tree = text.includes('"nodes"') ? parseAgentSnapshot(text) : null;
        if (tree?.nodes.length) this.trees.set(session, tree);
      });
    });
  }

  /** The session ended: drops its snapshot tree. */
  forget(session: string): void {
    this.trees.delete(session);
  }

  close(): void {
    for (const follower of this.followers.values()) follower.stop();
    this.followers.clear();
    this.trees.clear();
    this.hub.close();
  }
}
