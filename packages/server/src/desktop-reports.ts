import type { DesktopReportSnapshot, DesktopReportTarget } from './protocol.ts';
import type { DetailsRead } from './machine-details.ts';
import { GC_REPORT_STALE_MS } from '@stim-cli/core/state';

const MAX_REPORT_READS = 4;
/** The gc report's read budget in the background, instead of the API's 60 seconds that a large machine exceeds. */
export const GC_REPORT_BUDGET_MS: number = 15 * 60_000;
/** How long a failed gc refresh with no earlier report waits before a read starts another. */
const GC_REPORT_RETRY_MS = 5 * 60_000;

// @ref LLP 0012#the-gc-report-answers-from-its-cache -- a gc read never waits for a sweep
const cachedReport = (target: DesktopReportTarget) => target.report === 'gc';

export interface CachedReport {
  value: Record<string, unknown>;
  /** When the read that produced `value` started, in epoch milliseconds. */
  at: number;
}

const reportKey = (target: DesktopReportTarget) =>
  target.report === 'doctor' ? `doctor:${target.platform ?? 'all'}:${target.cwd}` : target.report;

interface Entry {
  target: DesktopReportTarget;
  generation: number;
  readers: number;
  settled?: { result: DetailsRead; at: number; generation: number };
  pending?: { promise: Promise<void>; generation: number; abort: AbortController };
  listeners: Set<(snapshot: DesktopReportSnapshot) => void>;
  published?: string;
  timer?: ReturnType<typeof setTimeout>;
  cached?: {
    good?: CachedReport;
    failure?: { message: string; at: number };
    /** A reader asked for fresh: the next read starts a sweep, or one starts after the sweep under way. */
    stale?: true;
  };
}

export class DesktopReports {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private activeLoads = 0;
  /** An invalidation reached the gc report before its entry existed, so the seeded report is stale. */
  private gcInvalidated = false;
  private readonly load: (target: DesktopReportTarget, signal: AbortSignal, fresh: boolean) => Promise<DetailsRead>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly seed: (target: DesktopReportTarget) => CachedReport | null;

  constructor(
    load: (target: DesktopReportTarget, signal: AbortSignal, fresh: boolean) => Promise<DetailsRead>,
    ttlMs = 60_000,
    now: () => number = Date.now,
    seed: (target: DesktopReportTarget) => CachedReport | null = () => null,
  ) {
    this.load = load;
    this.ttlMs = ttlMs;
    this.now = now;
    this.seed = seed;
  }

  async get(target: DesktopReportTarget, signal?: AbortSignal): Promise<DesktopReportSnapshot> {
    signal?.throwIfAborted();
    if (this.closed) return { pending: false, value: null, error: 'The server is closing.' };
    const entry = this.entry(target);
    if (entry.cached) {
      if (!entry.pending) this.reseed(entry);
      if (!entry.pending && this.refreshAt(entry) <= this.now()) this.start(entry);
      return this.snapshot(entry);
    }
    entry.readers++;
    let stopWaiting: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      stopWaiting = () => signal.removeEventListener('abort', abort);
    });
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (this.closed) return { pending: false, value: null, error: 'The server is closing.' };
        if (this.fresh(entry)) return this.snapshot(entry);
        const pending = entry.pending ?? this.start(entry);
        await Promise.race([pending.promise, aborted]);
        if (!this.closed && pending.generation === entry.generation) return this.snapshot(entry);
      }
    } finally {
      entry.readers--;
      stopWaiting?.();
    }
  }

  /** `get`, but while a cached report has no value yet it waits for the read under way to settle. */
  async first(target: DesktopReportTarget): Promise<DesktopReportSnapshot> {
    const snapshot = await this.get(target);
    const entry = this.entries.get(reportKey(target));
    if (snapshot.value !== null || !entry?.pending) return snapshot;
    await entry.pending.promise;
    return this.closed ? { pending: false, value: null, error: 'The server is closing.' } : this.snapshot(entry);
  }

  subscribe(target: DesktopReportTarget, listener: (snapshot: DesktopReportSnapshot) => void): () => void {
    if (this.closed) {
      listener({ pending: false, value: null, error: 'The server is closing.' });
      return () => {};
    }
    const entry = this.entry(target);
    if (!this.fresh(entry) && !entry.pending) this.start(entry);
    entry.listeners.add(listener);
    const snapshot = this.snapshot(entry);
    entry.published = JSON.stringify(snapshot);
    listener(snapshot);
    this.schedule(entry);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
    };
  }

  /** Invalidates `target`, or every target without one. */
  invalidate(target?: DesktopReportTarget): void {
    if (!target || cachedReport(target)) this.gcInvalidated = true;
    const only = target && this.entries.get(reportKey(target));
    if (target && !only) return;
    for (const entry of only ? [only] : this.entries.values()) {
      if (entry.cached) {
        entry.cached.stale = true;
        if (!entry.pending && entry.listeners.size) this.start(entry);
        continue;
      }
      entry.generation++;
      entry.pending?.abort.abort();
      clearTimeout(entry.timer);
      entry.timer = undefined;
      if (entry.listeners.size && !entry.pending) this.start(entry);
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.listeners.clear();
    }
    this.entries.clear();
  }

  private entry(target: DesktopReportTarget): Entry {
    for (const [key, entry] of this.entries) {
      if (
        !entry.cached &&
        !entry.readers &&
        !entry.listeners.size &&
        !entry.pending &&
        (!entry.settled || this.now() - entry.settled.at >= this.ttlMs)
      )
        this.entries.delete(key);
    }
    const key = reportKey(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { target, generation: 0, readers: 0, listeners: new Set() };
      if (cachedReport(target)) {
        const good = this.seed(target);
        entry.cached = good ? { good } : {};
        if (this.gcInvalidated) entry.cached.stale = true;
      }
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Takes a newer report another reader of stimd's shared sweep left in the cache, such as `stim gc --dry-run --refresh`. */
  private reseed(entry: Entry): void {
    const cached = entry.cached;
    const seeded = cached && this.seed(entry.target);
    if (!cached || !seeded || seeded.at <= (cached.good?.at ?? -Infinity)) return;
    cached.good = seeded;
    if (cached.failure && cached.failure.at <= seeded.at) delete cached.failure;
  }

  /** When `entry` should read again: its settled read's expiry, or for the gc report its staleness or retry time. */
  private refreshAt(entry: Entry): number {
    if (entry.cached) {
      const { good, failure, stale } = entry.cached;
      if (stale) return -Infinity;
      return Math.max(
        good ? good.at + GC_REPORT_STALE_MS : -Infinity,
        failure ? failure.at + GC_REPORT_RETRY_MS : -Infinity,
      );
    }
    return entry.settled ? entry.settled.at + this.ttlMs : -Infinity;
  }

  private fresh(entry: Entry): boolean {
    if (entry.cached) return this.refreshAt(entry) > this.now();
    return Boolean(
      entry.settled && entry.settled.generation === entry.generation && this.now() - entry.settled.at < this.ttlMs,
    );
  }

  private start(entry: Entry): NonNullable<Entry['pending']> {
    if (entry.pending) return entry.pending;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const admitted = this.activeLoads < MAX_REPORT_READS;
    if (admitted) this.activeLoads++;
    const generation = entry.generation;
    const startedAt = this.now();
    const fresh = Boolean(entry.cached?.stale);
    if (entry.cached) delete entry.cached.stale;
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then((): DetailsRead | Promise<DetailsRead> => {
        if (this.closed) return { ok: false, message: 'The server is closing.' };
        if (!admitted)
          return {
            ok: false,
            message: `The server is already running ${MAX_REPORT_READS} shared reports. Try again after a report finishes.`,
          };
        return this.load(entry.target, abort.signal, fresh);
      })
      .catch((cause: unknown): DetailsRead => ({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      }))
      .then((result) => {
        if (admitted) this.activeLoads--;
        if (entry.pending !== pending) return undefined;
        entry.pending = undefined;
        if (this.closed) return undefined;
        if (entry.cached) {
          const { stale } = entry.cached;
          entry.cached = result.ok
            ? { good: { value: result.report, at: result.measuredAt ?? startedAt } }
            : { ...entry.cached, failure: { message: result.message, at: this.now() } };
          if (stale) entry.cached.stale = stale;
          entry.settled = { result, at: this.now(), generation };
          if (stale && entry.listeners.size) this.start(entry);
          else this.publish(entry);
          this.schedule(entry);
          return undefined;
        }
        if (generation !== entry.generation) {
          if (entry.listeners.size) this.start(entry);
          return undefined;
        }
        entry.settled = { result, at: this.now(), generation };
        this.publish(entry);
        this.schedule(entry);
        return undefined;
      });
    const pending = { promise, generation, abort };
    entry.pending = pending;
    this.publish(entry);
    return pending;
  }

  private snapshot(entry: Entry): DesktopReportSnapshot {
    if (entry.cached) {
      const { good, failure } = entry.cached;
      return {
        pending: !good && (entry.pending !== undefined || !failure),
        value: good?.value ?? null,
        ...(good ? { measuredAt: new Date(good.at).toISOString() } : {}),
        ...(entry.pending ? { refreshing: true } : failure ? { error: failure.message } : {}),
      };
    }
    const result = entry.settled?.result;
    return {
      pending: entry.pending !== undefined || entry.settled?.generation !== entry.generation,
      value: result?.ok ? result.report : null,
      ...(result && !result.ok ? { error: result.message } : {}),
      ...(entry.settled ? { measuredAt: new Date(entry.settled.at).toISOString() } : {}),
    };
  }

  private publish(entry: Entry): void {
    if (!entry.listeners.size) return;
    const snapshot = this.snapshot(entry);
    const text = JSON.stringify(snapshot);
    if (text === entry.published) return;
    entry.published = text;
    for (const listener of entry.listeners) listener(snapshot);
  }

  private schedule(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (this.closed || !entry.listeners.size || entry.pending || (!entry.settled && !entry.cached?.good)) return;
    entry.timer = setTimeout(
      () => {
        if (entry.pending) return;
        entry.generation++;
        this.start(entry);
      },
      Math.max(0, this.refreshAt(entry) - this.now()),
    );
    entry.timer.unref();
  }
}
