import type { BuildPlan, LastBuild, Platform } from '@/protocol/types';

export type PlanState = { kind: 'checking' } | { kind: 'done'; plan: BuildPlan } | { kind: 'failed'; message: string };

interface Entry {
  state: PlanState;
  buildKey: string;
  checkedAt: number | null;
  token: object;
}

export type PlanSnapshot = ReadonlyMap<string, Entry>;

export const PLAN_FRESH_MS = 60_000;

/** Changes whenever a platform's last build record changes. */
export function planKey(last: LastBuild | null | undefined): string {
  return last ? `${last.startedAt}|${last.finishedAt ?? ''}|${last.status}` : '';
}

/**
 * Next-build predictions of one Mac, by workspace and platform. A workspace asks for one plan at a time,
 * a plan stays current for `PLAN_FRESH_MS` while its platform's last build is unchanged, a failure is asked
 * again on the next check, and a reply
 * for a cancelled check is ignored.
 */
export class PlanChecks {
  private entries = new Map<string, Entry>();
  private queues = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly request: (workspace: string, platform: Platform) => Promise<BuildPlan>,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes identity on every update, for `useSyncExternalStore`. */
  snapshot = (): PlanSnapshot => this.entries;

  static state(snapshot: PlanSnapshot, workspace: string, platform: Platform): PlanState | undefined {
    return snapshot.get(key(workspace, platform))?.state;
  }

  /** When the platform's last check settled, or null while none has. */
  static checkedAt(snapshot: PlanSnapshot, workspace: string, platform: Platform): number | null {
    return snapshot.get(key(workspace, platform))?.checkedAt ?? null;
  }

  /** Plans each platform, keyed by its last build, unless a check for that build is running or fresh. */
  check(workspace: string, builds: Partial<Record<Platform, string>>, force = false): void {
    for (const [platform, buildKey] of Object.entries(builds) as [Platform, string][]) {
      const id = key(workspace, platform);
      const entry = this.entries.get(id);
      if (entry?.buildKey === buildKey) {
        if (entry.state.kind === 'checking') continue;
        if (!force && entry.state.kind === 'done' && this.now() - (entry.checkedAt ?? 0) < PLAN_FRESH_MS) continue;
      }
      const token = {};
      this.set(id, { state: { kind: 'checking' }, buildKey, checkedAt: null, token });
      const settle = (state: PlanState) => {
        if (this.entries.get(id)?.token === token) this.set(id, { state, buildKey, checkedAt: this.now(), token });
      };
      const turn = (this.queues.get(workspace) ?? Promise.resolve()).then(async () => {
        if (this.entries.get(id)?.token !== token) return;
        try {
          settle({ kind: 'done', plan: await this.request(workspace, platform) });
        } catch (cause) {
          settle({ kind: 'failed', message: (cause as Error).message });
        }
      });
      this.queues.set(workspace, turn);
      void turn.finally(() => {
        if (this.queues.get(workspace) === turn) this.queues.delete(workspace);
      });
    }
  }

  /** Forgets the workspace's running and queued checks, whose replies are then ignored; results stay. */
  cancel(workspace: string): void {
    const ids = (['ios', 'android'] as const)
      .map((platform) => key(workspace, platform))
      .filter((id) => this.entries.get(id)?.state.kind === 'checking');
    if (!ids.length) return;
    this.entries = new Map(this.entries);
    for (const id of ids) this.entries.delete(id);
    this.publish();
  }

  private set(id: string, entry: Entry): void {
    this.entries = new Map(this.entries).set(id, entry);
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

const key = (workspace: string, platform: Platform) => `${workspace}\n${platform}`;
