import type { DesktopReportSnapshot, DesktopReportTarget } from './protocol.ts';
import type { DetailsRead } from './machine-details.ts';

const MAX_REPORT_READS = 4;

interface Entry {
  target: DesktopReportTarget;
  generation: number;
  settled?: { result: DetailsRead; at: number; generation: number };
  pending?: { promise: Promise<void>; generation: number };
  listeners: Set<(snapshot: DesktopReportSnapshot) => void>;
  published?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class DesktopReports {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private activeLoads = 0;
  private readonly load: (target: DesktopReportTarget) => Promise<DetailsRead>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    load: (target: DesktopReportTarget) => Promise<DetailsRead>,
    ttlMs = 60_000,
    now: () => number = Date.now,
  ) {
    this.load = load;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async get(target: DesktopReportTarget, signal?: AbortSignal): Promise<DesktopReportSnapshot> {
    signal?.throwIfAborted();
    if (this.closed) return { pending: false, value: null, error: 'The server is closing.' };
    const entry = this.entry(target);
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
      stopWaiting?.();
    }
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

  invalidate(): void {
    for (const entry of this.entries.values()) {
      entry.generation++;
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
      if (!entry.listeners.size && !entry.pending && entry.settled && this.now() - entry.settled.at >= this.ttlMs)
        this.entries.delete(key);
    }
    const key = target.report === 'gc' ? 'gc' : `doctor:${target.cwd}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { target, generation: 0, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private fresh(entry: Entry): boolean {
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
    const promise = Promise.resolve()
      .then((): DetailsRead | Promise<DetailsRead> => {
        if (this.closed) return { ok: false, message: 'The server is closing.' };
        if (!admitted)
          return {
            ok: false,
            message: `The server is already running ${MAX_REPORT_READS} shared reports. Try again after a report finishes.`,
          };
        return this.load(entry.target);
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
        if (generation !== entry.generation) {
          if (entry.listeners.size) this.start(entry);
          return undefined;
        }
        entry.settled = { result, at: this.now(), generation };
        this.publish(entry);
        this.schedule(entry);
        return undefined;
      });
    const pending = { promise, generation };
    entry.pending = pending;
    this.publish(entry);
    return pending;
  }

  private snapshot(entry: Entry): DesktopReportSnapshot {
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
    if (this.closed || !entry.listeners.size || entry.pending || !entry.settled) return;
    entry.timer = setTimeout(
      () => {
        if (entry.pending) return;
        entry.generation++;
        this.start(entry);
      },
      Math.max(0, this.ttlMs - (this.now() - entry.settled.at)),
    );
    entry.timer.unref();
  }
}
