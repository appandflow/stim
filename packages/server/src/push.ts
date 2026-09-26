import type { StatusPayload } from '@stim-cli/core/state';
import { attentionCandidates, type AttentionCandidate } from './attention.ts';
import type { FeedListener } from './feed.ts';
import { diffAttention, type NotifyEntries } from './notify.ts';
import type { MachineVolume } from './protocol.ts';
import type { PairedDevice, PushRegistration } from './registry.ts';

export const EXPO_PUSH_API: string = 'https://exp.host/--/api/v2/push';

export interface PushLimits {
  /** How often overruns are rechecked while status is unchanged. */
  tickMs: number;
  diskMs: number;
  /** Expo keeps receipts for a day and may need minutes to produce them. */
  receiptDelayMs: number;
  /** Pushes a device may receive per hour; later ones are dropped. */
  perHour: number;
  /** More notifications than this at once become one summary. */
  summarizeAbove: number;
  resubscribeMs: number;
}

const DEFAULT_PUSH_LIMITS: PushLimits = {
  tickMs: 30_000,
  diskMs: 60_000,
  receiptDelayMs: 15 * 60_000,
  perHour: 20,
  summarizeAbove: 3,
  resubscribeMs: 30_000,
};

export interface PushNotifierOptions {
  name: string;
  endpoint: string;
  subscribeStatus: (listener: FeedListener) => () => void;
  readVolumes: () => MachineVolume[];
  devices: () => PairedDevice[];
  dropToken: (token: string) => void;
  limits?: Partial<PushLimits>;
  now?: () => number;
}

export interface PushMessage {
  to: string;
  title: string;
  subtitle?: string;
  body: string;
  sound: 'default';
  data: { ref: string; target: 'home' | 'machine' | 'workspace' | 'logs'; path?: string };
}

interface Registered {
  push: PushRegistration;
  entries: NotifyEntries | null;
  bucket: { tokens: number; at: number };
}

interface Ticket {
  status?: unknown;
  id?: unknown;
  details?: { error?: unknown };
}

/**
 * Pushes attention notifications to the devices that asked with `push.register`. While any device is
 * registered it keeps its own `stim status --watch --json` subscription and reads the disks every minute.
 */
export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly limits: PushLimits;
  private readonly now: () => number;
  private readonly registered = new Map<string, Registered>();
  private unsubscribe: (() => void) | null = null;
  private status: StatusPayload | null = null;
  private volumes: MachineVolume[] | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  private tick: NodeJS.Timeout | null = null;
  private disk: NodeJS.Timeout | null = null;
  private wake: NodeJS.Timeout | null = null;
  private resubscribe: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_PUSH_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  /** Rereads the registrations; a device whose token is new starts from what is already wrong. */
  refresh(): void {
    if (this.closed) return;
    const current = new Map(this.options.devices().flatMap((d) => (d.push ? [[d.id, d.push] as const] : [])));
    for (const id of this.registered.keys()) if (!current.has(id)) this.registered.delete(id);
    for (const [id, push] of current) {
      const known = this.registered.get(id);
      if (known && known.push.token === push.token) known.push = push;
      else this.registered.set(id, { push, entries: null, bucket: { tokens: this.limits.perHour, at: this.now() } });
    }
    if (this.registered.size > 0) this.watch();
    else this.unwatch();
  }

  close(): void {
    this.closed = true;
    this.unwatch();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private watch(): void {
    if (!this.unsubscribe && !this.resubscribe) this.subscribe();
    if (!this.tick) this.tick = setInterval(() => this.evaluate(), this.limits.tickMs);
    if (!this.disk) {
      this.readDisk();
      this.disk = setInterval(() => {
        this.readDisk();
        this.evaluate();
      }, this.limits.diskMs);
    }
  }

  private unwatch(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of [this.tick, this.disk]) if (timer) clearInterval(timer);
    for (const timer of [this.wake, this.resubscribe]) if (timer) clearTimeout(timer);
    this.tick = this.disk = this.wake = this.resubscribe = null;
    this.status = null;
    this.volumes = null;
  }

  private subscribe(): void {
    this.unsubscribe = this.options.subscribeStatus({
      item: (value) => {
        this.status = value as unknown as StatusPayload;
        this.evaluate();
      },
      failed: (message) => {
        console.error(`stim-server: push notifications paused: ${message}`);
        this.unsubscribe = null;
        this.resubscribe = setTimeout(() => {
          this.resubscribe = null;
          if (this.registered.size > 0 && !this.closed) this.subscribe();
        }, this.limits.resubscribeMs);
      },
    });
  }

  private readDisk(): void {
    try {
      this.volumes = this.options.readVolumes();
    } catch {
      this.volumes = null;
    }
  }

  private evaluate(): void {
    const status = this.status;
    if (!status || this.closed) return;
    const now = this.now();
    const candidates = attentionCandidates(status, this.volumes, this.options.name, now);
    const messages: PushMessage[] = [];
    let wakeAt: number | null = null;
    for (const device of this.registered.values()) {
      const diff = diffAttention(device.entries, candidates, device.push, now);
      device.entries = diff.entries;
      if (diff.wakeAt !== null) wakeAt = wakeAt === null ? diff.wakeAt : Math.min(wakeAt, diff.wakeAt);
      const due =
        diff.notify.length > this.limits.summarizeAbove
          ? [this.summary(device, diff.notify)]
          : diff.notify.map((c) => this.message(device.push, c));
      for (const message of due) if (this.take(device, now)) messages.push(message);
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

  private message(push: PushRegistration, candidate: AttentionCandidate): PushMessage {
    const machine = candidate.target.kind === 'machine';
    return {
      to: push.token,
      title: candidate.title,
      ...(machine ? {} : { subtitle: this.options.name }),
      body: candidate.reason,
      sound: 'default',
      data: {
        ref: push.ref,
        target: candidate.target.kind,
        ...(candidate.target.kind === 'machine' ? {} : { path: candidate.target.path }),
      },
    };
  }

  private summary(device: Registered, candidates: AttentionCandidate[]): PushMessage {
    return {
      to: device.push.token,
      title: this.options.name,
      body: `${candidates.length} problems need attention`,
      sound: 'default',
      data: { ref: device.push.ref, target: 'home' },
    };
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
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
      console.error(`stim-server: could not send ${messages.length} push notifications: ${(cause as Error).message}`);
      return;
    }
    if (!Array.isArray(tickets)) return;
    const receipts = new Map<string, string>();
    tickets.forEach((ticket: Ticket, index) => {
      const to = messages[index]?.to;
      if (!to) return;
      if (ticket.status === 'ok' && typeof ticket.id === 'string') receipts.set(ticket.id, to);
      else if (ticket.details?.error === 'DeviceNotRegistered') this.options.dropToken(to);
    });
    if (receipts.size > 0) this.later(() => void this.checkReceipts(receipts), this.limits.receiptDelayMs);
  }

  private async checkReceipts(receipts: Map<string, string>): Promise<void> {
    let data: unknown;
    try {
      data = await this.post('getReceipts', { ids: [...receipts.keys()] });
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    for (const [id, receipt] of Object.entries(data as Record<string, Ticket>)) {
      const to = receipts.get(id);
      if (to && receipt.details?.error === 'DeviceNotRegistered') this.options.dropToken(to);
    }
  }
}
