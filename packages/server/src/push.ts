import { createHash } from 'node:crypto';
import type { StatusPayload } from '@stim-cli/core/state';
import type { FeedListener } from './feed.ts';
import type { LoggedNotification, NewEntry, NotificationLog } from './notification-log.ts';
import {
  DEFAULT_STUCK_MINUTES,
  inQuietHours,
  OVERSIGHT_CATEGORIES,
  oversee,
  type OversightCategory,
  type OversightNotification,
  type OversightPullRequest,
  type OversightState,
  type OversightTarget,
} from './oversight.ts';
import type {
  MachineVolume,
  MemoryPressure,
  NotificationLevel,
  NotificationSuppression,
  QuietHours,
} from './protocol.ts';
import type { PairedDevice, PushRegistration } from './registry.ts';

export const EXPO_PUSH_API: string = 'https://exp.host/--/api/v2/push';

export interface PushLimits {
  /** How often timed rules and overruns are rechecked while status is unchanged. */
  tickMs: number;
  diskMs: number;
  /** How often the workspaces' pull requests are looked up while a device wants `finished`. */
  pullRequestMs: number;
  /** Expo keeps receipts for a day and may need minutes to produce them. */
  receiptDelayMs: number;
  /** Pushes that alert a device may receive per hour; later ones are dropped. Silent ones do not count. */
  perHour: number;
  /** More notifications than this at once become one summary. */
  summarizeAbove: number;
  resubscribeMs: number;
}

const DEFAULT_PUSH_LIMITS: PushLimits = {
  tickMs: 30_000,
  diskMs: 60_000,
  pullRequestMs: 5 * 60_000,
  receiptDelayMs: 15 * 60_000,
  perHour: 20,
  summarizeAbove: 3,
  resubscribeMs: 30_000,
};

/** A linked worktree whose pull request the notifier asks about. */
interface PullRequestWorktree {
  path: string;
  branch: string;
  repository: string;
}

export interface PushNotifierOptions {
  name: string;
  endpoint: string;
  subscribeStatus: (listener: FeedListener) => () => void;
  readVolumes: () => MachineVolume[];
  readPressure: () => Promise<MemoryPressure | null>;
  /** Each worktree's pull request by path, null for none; a worktree left out could not be looked up. */
  pullRequests: (worktrees: PullRequestWorktree[]) => Promise<Map<string, OversightPullRequest | null>>;
  /** `grantedAt` of the device leases this server holds for phones that control a device. */
  ownLeases: () => readonly string[];
  devices: () => PairedDevice[];
  dropToken: (token: string) => void;
  /** Where every notification the rules produce for this Mac is logged, pushed or not. */
  log: NotificationLog;
  /** Whether the rules run while any device is paired, or only while one is registered for pushes. */
  whilePaired: boolean;
  logged?: (entries: LoggedNotification[]) => void;
  limits?: Partial<PushLimits>;
  now?: () => number;
}

type PushTarget =
  | { target: 'home' }
  | { target: 'machine' }
  | { target: 'workspace'; path: string }
  | { target: 'device'; path: string; platform: 'ios' | 'android' | 'web'; slot: string }
  | { target: 'build'; path: string; platform: 'ios' | 'android' }
  | { target: 'url'; path: string; url: string };

export interface PushMessage {
  to: string;
  title: string;
  subtitle?: string;
  body: string;
  sound: 'default' | null;
  interruptionLevel: 'active' | 'passive';
  /** The phone's Android channel: `attention` alerts, `updates` is silent. */
  channelId: 'attention' | 'updates';
  /** Replaces a notification the phone still shows for the same workspace and category. */
  collapseId?: string;
  threadId?: string;
  /** `notification` is the `seq` of the logged entry the push reports, when the log holds it. */
  data: { ref: string; notification?: number } & PushTarget;
}

/** A conflict over a device a phone controls, pushed to that phone. */
export interface ControlConflict {
  workspace: string;
  title: string;
  body: string;
  platform: 'ios' | 'android' | 'web';
  slot: string;
}

const PUSH_TOKEN = /(Expo|Exponent)PushToken\[([^\]\s]*)\]?/g;

export function maskPushTokens(text: string): string {
  return text.replace(
    PUSH_TOKEN,
    (_, prefix: string, body: string) =>
      `${prefix}PushToken[#${createHash('sha256').update(body).digest('hex').slice(0, 8)}]`,
  );
}

function warn(text: string): void {
  console.error(`stim-server: ${maskPushTokens(text)}`);
}

/** The minutes after midnight in `timeZone` at `now`. */
function minuteOfDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(now)
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

const quietNow = (quietHours: QuietHours | null, now: number) =>
  quietHours !== null && inQuietHours(quietHours, minuteOfDay(now, quietHours.timeZone));

/** APNs caps a collapse id at 64 bytes, and a workspace path can be longer. */
const collapseId = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);

function targetData(target: OversightTarget): PushTarget {
  const { kind, ...rest } = target;
  return { target: kind, ...rest } as PushTarget;
}

const wants = (device: Registered, category: OversightCategory) => device.push.events.includes(category);

function entryOf(notification: OversightNotification, suppressed: NotificationSuppression | null): NewEntry {
  const { id, category, title, body, quiet, target } = notification;
  return { id, category, title, body, quiet, target, ...(suppressed ? { suppressed } : {}) };
}

const levelOf = (push: PushRegistration, notification: OversightNotification): NotificationLevel =>
  push.levels?.[notification.category] ?? (notification.quiet ? 'silent' : 'alert');

const DELIVERY = {
  alert: { sound: 'default', interruptionLevel: 'active', channelId: 'attention' },
  silent: { sound: null, interruptionLevel: 'passive', channelId: 'updates' },
} as const satisfies Record<NotificationLevel, Pick<PushMessage, 'sound' | 'interruptionLevel' | 'channelId'>>;

interface Registered {
  id: string;
  push: PushRegistration;
  state: OversightState | null;
  bucket: { tokens: number; at: number };
}

interface Ticket {
  status?: unknown;
  message?: unknown;
  id?: unknown;
  details?: { error?: unknown };
}

/**
 * Logs this Mac's notifications and pushes them to the devices that asked with `push.register`. While any device is
 * paired, or with `whilePaired` false registered, it keeps its own `stim status --watch --json` subscription and
 * reads the disks and memory pressure every minute, and, while a device wants `finished`, looks up the pushed
 * worktrees' pull requests every few minutes.
 */
export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly limits: PushLimits;
  private readonly now: () => number;
  private readonly registered = new Map<string, Registered>();
  private history: OversightState | null = null;
  private unsubscribe: (() => void) | null = null;
  private status: StatusPayload | null = null;
  private volumes: MachineVolume[] | null = null;
  private pressure: MemoryPressure | null = null;
  private pullRequests: Record<string, OversightPullRequest | null> = {};
  private readonly timers = new Set<NodeJS.Timeout>();
  private tick: NodeJS.Timeout | null = null;
  private disk: NodeJS.Timeout | null = null;
  private lookups: NodeJS.Timeout | null = null;
  private wake: NodeJS.Timeout | null = null;
  private resubscribe: NodeJS.Timeout | null = null;
  private lookingUp = false;
  private closed = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_PUSH_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  /** Rereads the registrations; a device whose token is new starts from what is already true. */
  refresh(): void {
    if (this.closed) return;
    const devices = this.options.devices();
    const current = new Map(devices.flatMap((d) => (d.push?.events.length ? [[d.id, d.push] as const] : [])));
    for (const id of this.registered.keys()) if (!current.has(id)) this.registered.delete(id);
    let added = false;
    for (const [id, push] of current) {
      const known = this.registered.get(id);
      if (known && known.push.token === push.token) {
        known.push = push;
        continue;
      }
      this.registered.set(id, { id, push, state: null, bucket: { tokens: this.limits.perHour, at: this.now() } });
      added = true;
    }
    if ((this.options.whilePaired ? devices.length : current.size) > 0) this.watch();
    else this.unwatch();
    if (added) this.evaluate();
  }

  /** Logs a control conflict for the device `deviceId`, and pushes it when the device registered for `control`. */
  control(deviceId: string, conflict: ControlConflict): void {
    if (this.closed) return;
    const device = this.registered.get(deviceId);
    const now = this.now();
    const { workspace, platform, slot } = conflict;
    const notification: OversightNotification = {
      id: `control:${workspace}:${platform}:${slot}`,
      category: 'control',
      title: conflict.title,
      body: conflict.body,
      quiet: true,
      thread: null,
      target: { kind: 'device', path: workspace, platform, slot },
    };
    const suppressed = device ? this.suppression('control', [device], now) : null;
    this.record([{ ...entryOf(notification, suppressed), device: deviceId }]);
    if (!device || suppressed !== null) return;
    const message = this.message(device, notification);
    if (message.interruptionLevel === 'passive' || this.take(device, now)) void this.send([message]);
  }

  close(): void {
    this.closed = true;
    this.unwatch();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private watching(): boolean {
    return this.options.whilePaired ? this.options.devices().length > 0 : this.registered.size > 0;
  }

  private watch(): void {
    if (!this.disk) {
      void this.readMachine();
      this.disk = setInterval(() => void this.readMachine(), this.limits.diskMs);
    }
    if (!this.tick) this.tick = setInterval(() => this.evaluate(), this.limits.tickMs);
    if (!this.lookups) this.lookups = setInterval(() => void this.lookUpPullRequests(), this.limits.pullRequestMs);
    if (!this.unsubscribe && !this.resubscribe) this.subscribe();
  }

  private unwatch(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of [this.tick, this.disk, this.lookups]) if (timer) clearInterval(timer);
    for (const timer of [this.wake, this.resubscribe]) if (timer) clearTimeout(timer);
    this.tick = this.disk = this.lookups = this.wake = this.resubscribe = null;
    this.status = null;
    this.history = null;
    this.volumes = null;
    this.pressure = null;
    this.pullRequests = {};
  }

  private subscribe(): void {
    let first = true;
    this.unsubscribe = this.options.subscribeStatus({
      item: (value) => {
        this.status = value as unknown as StatusPayload;
        this.evaluate();
        if (first) {
          first = false;
          void this.lookUpPullRequests();
        }
      },
      failed: (message) => {
        warn(`push notifications paused: ${message}`);
        this.unsubscribe = null;
        this.status = null;
        this.resubscribe = setTimeout(() => {
          this.resubscribe = null;
          if (this.watching() && !this.closed) this.subscribe();
        }, this.limits.resubscribeMs);
      },
    });
  }

  private async readMachine(): Promise<void> {
    try {
      this.volumes = this.options.readVolumes();
    } catch {
      this.volumes = null;
    }
    try {
      this.pressure = await this.options.readPressure();
    } catch {
      this.pressure = null;
    }
    this.evaluate();
  }

  /** Asks GitHub about the pushed worktrees' branches, only while a device wants `finished`. */
  private async lookUpPullRequests(): Promise<void> {
    const status = this.status;
    if (!status || this.lookingUp || this.closed) return;
    if (![...this.registered.values()].some((device) => wants(device, 'finished'))) return;
    const worktrees = status.environments.flatMap(({ path, worktree }) =>
      worktree?.branch && worktree.repository && worktree.git?.upstream
        ? [{ path, branch: worktree.branch, repository: worktree.repository }]
        : [],
    );
    if (worktrees.length === 0) return;
    this.lookingUp = true;
    try {
      const found = await this.options.pullRequests(worktrees);
      if (this.closed || !this.watching()) return;
      this.pullRequests = Object.fromEntries(found);
      this.evaluate();
    } catch (cause) {
      warn(`could not look up pull requests: ${(cause as Error).message}`);
    } finally {
      this.lookingUp = false;
    }
  }

  private evaluate(): void {
    const status = this.status;
    if (!status || this.closed) return;
    const now = this.now();
    const input = {
      machine: this.options.name,
      status,
      volumes: this.volumes,
      memoryPressure: this.pressure,
      link: null,
      pullRequests: this.pullRequests,
      ownLeases: this.options.ownLeases(),
    };
    const registered = [...this.registered.values()];
    const stuckThresholds = registered.flatMap((device) => (wants(device, 'stuck') ? [device.push.stuckMinutes] : []));
    const lowestStuck = stuckThresholds.length ? Math.min(...stuckThresholds) : DEFAULT_STUCK_MINUTES;
    const everything = oversee(
      this.history,
      input,
      { categories: OVERSIGHT_CATEGORIES, stuckMinutes: lowestStuck, quiet: false },
      now,
    );
    this.history = everything.state;
    this.record(everything.notifications.map((n) => entryOf(n, this.suppression(n.category, registered, now))));
    const messages: PushMessage[] = [];
    let wakeAt = everything.wakeAt;
    for (const device of registered) {
      const { events, stuckMinutes, quietHours } = device.push;
      const prefs = { categories: events, stuckMinutes, quiet: quietNow(quietHours, now) };
      const result = oversee(device.state, input, prefs, now);
      device.state = result.state;
      if (result.wakeAt !== null) wakeAt = wakeAt === null ? result.wakeAt : Math.min(wakeAt, result.wakeAt);
      const due =
        result.notifications.length > this.limits.summarizeAbove
          ? [this.summary(device, result.notifications)]
          : result.notifications.map((n) => this.message(device, n));
      for (const message of due) {
        if (message.interruptionLevel === 'passive' || this.take(device, now)) messages.push(message);
      }
    }
    if (this.wake) clearTimeout(this.wake);
    this.wake = wakeAt === null ? null : setTimeout(() => this.evaluate(), Math.max(0, wakeAt - now));
    if (messages.length > 0) void this.send(messages);
  }

  private take(device: Registered, now: number): boolean {
    const { bucket } = device;
    bucket.tokens = Math.min(
      this.limits.perHour,
      bucket.tokens + ((now - bucket.at) * this.limits.perHour) / 3_600_000,
    );
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Why none of `devices` gets a `category` notification now, or null when one does. */
  private suppression(category: OversightCategory, devices: Registered[], now: number): NotificationSuppression | null {
    const wanting = devices.filter((device) => wants(device, category));
    if (devices.length === 0 || wanting.some((device) => !quietNow(device.push.quietHours, now))) return null;
    return wanting.length === 0 ? 'muted' : 'quiet-hours';
  }

  private record(entries: NewEntry[]): void {
    if (entries.length === 0) return;
    let logged: LoggedNotification[];
    try {
      logged = this.options.log.append(entries);
    } catch (cause) {
      warn(`could not log ${entries.length} notifications: ${(cause as Error).message}`);
      return;
    }
    this.options.logged?.(logged);
  }

  private message(device: Registered, notification: OversightNotification): PushMessage {
    const { push } = device;
    const seq = this.options.log.latest(notification.id, device.id);
    return {
      to: push.token,
      title: notification.title,
      ...(notification.target.kind === 'machine' ? {} : { subtitle: this.options.name }),
      body: notification.body,
      ...DELIVERY[levelOf(push, notification)],
      collapseId: collapseId(`${push.ref}\n${notification.id}`),
      ...(notification.thread ? { threadId: notification.thread } : {}),
      data: { ref: push.ref, ...(seq === null ? {} : { notification: seq }), ...targetData(notification.target) },
    };
  }

  private summary(device: Registered, notifications: OversightNotification[]): PushMessage {
    const silent = notifications.every((n) => levelOf(device.push, n) === 'silent');
    return {
      to: device.push.token,
      title: this.options.name,
      body: `${notifications.length} things need a look`,
      ...DELIVERY[silent ? 'silent' : 'alert'],
      data: { ref: device.push.ref, target: 'home' },
    };
  }

  private later(fn: () => void, ms: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    timer.unref();
    this.timers.add(timer);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.options.endpoint}/${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { data?: unknown }).data;
  }

  private async send(messages: PushMessage[]): Promise<void> {
    let tickets: unknown;
    try {
      tickets = await this.post('send', messages);
    } catch (cause) {
      warn(`could not send ${messages.length} push notifications: ${(cause as Error).message}`);
      return;
    }
    if (!Array.isArray(tickets) || this.closed) return;
    const receipts = new Map<string, string>();
    tickets.forEach((ticket: Ticket | null, index) => {
      const to = messages[index]?.to;
      if (!to) return;
      if (ticket?.status === 'ok' && typeof ticket.id === 'string') receipts.set(ticket.id, to);
      else if (ticket?.details?.error === 'DeviceNotRegistered') this.drop(to);
      else if (ticket?.status === 'error') warn(`Expo refused a push: ${String(ticket.message)}`);
    });
    if (receipts.size > 0) this.later(() => void this.checkReceipts(receipts), this.limits.receiptDelayMs);
  }

  private drop(token: string): void {
    try {
      this.options.dropToken(token);
    } catch (cause) {
      warn(`could not drop an unregistered push token: ${(cause as Error).message}`);
    }
  }

  private async checkReceipts(receipts: Map<string, string>): Promise<void> {
    let data: unknown;
    try {
      data = await this.post('getReceipts', { ids: [...receipts.keys()] });
    } catch {
      return;
    }
    if (!data || typeof data !== 'object' || this.closed) return;
    for (const [id, receipt] of Object.entries(data as Record<string, Ticket | null>)) {
      const to = receipts.get(id);
      if (to && receipt?.details?.error === 'DeviceNotRegistered') this.drop(to);
      else if (receipt?.status === 'error') warn(`a push failed: ${String(receipt.message)}`);
    }
  }
}
