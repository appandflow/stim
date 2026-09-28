import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import { isJsonObject, readJsonObject } from '@stim-cli/core/state';
import {
  NOTIFICATION_SUPPRESSIONS,
  PUSH_EVENTS,
  type NotificationEntry,
  type NotificationsListResult,
  type NotificationSuppression,
} from './protocol.ts';
import { writeJson } from './registry.ts';

const LIMITS = { entries: 200, ageMs: 7 * 24 * 60 * 60_000 };

/** A logged notification, and for a control conflict the paired device it concerns, the only one that lists it. */
export interface LoggedNotification extends NotificationEntry {
  device?: string;
}

export type NewEntry = Omit<LoggedNotification, 'seq' | 'at'>;

interface LogFile {
  log: string;
  nextSeq: number;
  entries: LoggedNotification[];
}

function parseEntry(value: unknown): LoggedNotification | null {
  if (!isJsonObject(value)) return null;
  const { seq, at, id, category, title, body, quiet, target, suppressed, device } = value;
  if (!Number.isInteger(seq) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof body !== 'string') return null;
  if (!(PUSH_EVENTS as readonly unknown[]).includes(category) || typeof quiet !== 'boolean') return null;
  if (!isJsonObject(target) || typeof target.kind !== 'string') return null;
  if (suppressed !== undefined && !(NOTIFICATION_SUPPRESSIONS as readonly unknown[]).includes(suppressed)) return null;
  return {
    seq: seq as number,
    at,
    id,
    category: category as LoggedNotification['category'],
    title,
    body,
    quiet,
    target: target as unknown as LoggedNotification['target'],
    ...(suppressed ? { suppressed: suppressed as NotificationSuppression } : {}),
    ...(typeof device === 'string' ? { device } : {}),
  };
}

function parseLog(value: Record<string, unknown> | null): LogFile | null {
  if (!value || typeof value.log !== 'string' || !Number.isInteger(value.nextSeq)) return null;
  const entries = Array.isArray(value.entries) ? value.entries.flatMap((entry) => parseEntry(entry) ?? []) : [];
  return { log: value.log, nextSeq: value.nextSeq as number, entries };
}

/**
 * The oversight notifications this server generated, newest last, kept in `file` within {@link LIMITS}. Sequence numbers only grow, and `log` names the
 * file's lifetime, so a client can tell a cursor from a log that was deleted since.
 */
export class NotificationLog {
  private readonly file: string;
  private readonly now: () => number;
  private state: LogFile;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.state = parseLog(readJsonObject(file)) ?? { log: randomBytes(8).toString('hex'), nextSeq: 1, entries: [] };
  }

  /** Appends `entries` in order and returns them as stored; the write reads the file first, under its lock. */
  append(entries: NewEntry[]): LoggedNotification[] {
    if (entries.length === 0) return [];
    const at = new Date(this.now()).toISOString();
    return withDirLock(
      `${this.file}.lock`,
      () => {
        const current = parseLog(readJsonObject(this.file)) ?? this.state;
        const added = entries.map((entry, i) => ({ ...entry, seq: current.nextSeq + i, at }));
        const next = {
          log: current.log,
          nextSeq: current.nextSeq + added.length,
          entries: this.bounded([...current.entries, ...added]),
        };
        writeJson(this.file, { version: 1, ...next });
        this.state = next;
        return added;
      },
      { ensureParent: () => mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }) },
    );
  }

  /** The entries `device` may see after `since`, newest first. */
  list(device: string, since = 0): NotificationsListResult {
    const notifications = this.bounded(this.state.entries)
      .filter((entry) => entry.seq > since && (entry.device === undefined || entry.device === device))
      .map(publicEntry)
      .toReversed();
    return { log: this.state.log, cursor: this.state.nextSeq - 1, notifications };
  }

  /** The newest entry with notification id `id` that `device` may see, as a push names it. */
  latest(id: string, device: string): number | null {
    const found = this.state.entries.findLast(
      (entry) => entry.id === id && (entry.device === undefined || entry.device === device),
    );
    return found?.seq ?? null;
  }

  get id(): string {
    return this.state.log;
  }

  private bounded(entries: LoggedNotification[]): LoggedNotification[] {
    const oldest = this.now() - LIMITS.ageMs;
    return entries.filter((entry) => Date.parse(entry.at) >= oldest).slice(-LIMITS.entries);
  }
}

export function publicEntry({ device: _device, ...entry }: LoggedNotification): NotificationEntry {
  return entry;
}

export function notificationLogFile(serverDir: string): string {
  return join(serverDir, 'notifications.json');
}
