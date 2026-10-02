import type { ProjectRecord, StimConfig } from '@stim-cli/core/state';
import type { AuditRecord } from './actions.ts';
import type { BuildClientSummary, BuildMachineReport, MachineDetails } from './protocol.ts';
import type { CommandOutcome } from './stim-command.ts';

/**
 * The only commands `machine.details` runs. Any other `gc` flag either deletes or drops the device and runtime
 * inventory from the payload.
 */
const GC_DRY_RUN = ['gc', '--json'];
const DOCTOR = ['doctor', '--json', '--platform', 'ios'];

const MACHINE_DETAILS_TTL_MS = 60_000;

function part(outcome: CommandOutcome, label: string): { payload: Record<string, unknown> | null; error?: string } {
  if (!outcome.ok) return { payload: null, error: outcome.message };
  try {
    const value: unknown = JSON.parse(outcome.stdout);
    if (isObject(value)) return { payload: value };
  } catch {}
  return { payload: null, error: `${label} printed output that is not a JSON object.` };
}

const iosDoctorRanAt = ([, record]: [string, ProjectRecord]) => Date.parse(record.doctorRuns?.ios?.at ?? '') || 0;

/**
 * Where `machine.details` runs `stim doctor` for the build machines: null when `offload.machines` names none, else
 * the registered workspace that still exists and ran doctor for iOS most recently, or the first one; `cwd` is null
 * when no registered workspace exists. Doctor refuses outside a project, and judges a machine against that app.
 */
export function doctorWorkspace(
  config: Pick<StimConfig, 'projects' | 'offload'> | null,
  exists: (path: string) => boolean,
): { cwd: string | null } | null {
  const machines = config?.offload?.machines;
  if (!Array.isArray(machines) || machines.length === 0) return null;
  const candidates = Object.entries(config?.projects ?? {}).filter(([path]) => exists(path));
  const newest = candidates.reduce<(typeof candidates)[number] | null>(
    (best, entry) => (best === null || iosDoctorRanAt(entry) > iosDoctorRanAt(best) ? entry : best),
    null,
  );
  return { cwd: newest?.[0] ?? null };
}

/** Where to run doctor, why it cannot run, or null when no build machine is named. */
export type DoctorTarget = { cwd: string | null } | { error: string } | null;

/** The build-machines part of a `machine.details` reply, without the pending flag a stale-cache read adds. */
type BuildMachinesResult = { buildMachines: BuildMachineReport[] | null; buildMachinesError?: string };

async function runDoctor(
  run: (args: string[], cwd?: string) => Promise<CommandOutcome>,
  cwd: string,
): Promise<BuildMachinesResult> {
  const { payload, error } = part(await run(DOCTOR, cwd), 'stim doctor');
  if (!payload) return { buildMachines: null, buildMachinesError: error! };
  const machines = payload.buildMachines;
  if (!Array.isArray(machines)) {
    return { buildMachines: null, buildMachinesError: 'This stim does not report build machines; update it.' };
  }
  return {
    buildMachines: machines.filter(
      (entry): entry is BuildMachineReport =>
        isObject(entry) && typeof entry.machine === 'string' && typeof entry.state === 'string',
    ),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The build-machines part of `machine.details`, refreshed with `stim doctor --json --platform ios` in the
 * background instead of blocking the reply: doctor's offer to an unreachable machine can take about 13 seconds,
 * and the rest of `machine.details` has nothing to do with it. `snapshot` never awaits doctor. It returns the last
 * settled result immediately (with `buildMachinesPending: true` alongside it once that result is `ttlMs` old or
 * older), starting at most one background run to refresh it; while no result has ever settled, it returns
 * `buildMachines: null` with `buildMachinesPending: true`. `offload.machines` naming no machine, or `doctor` being
 * an error or an unresolved workspace, answers synchronously and never starts a run.
 */
export class BuildMachinesCache {
  private settled: { result: BuildMachinesResult; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number = MACHINE_DETAILS_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  snapshot(
    run: (args: string[], cwd?: string) => Promise<CommandOutcome>,
    doctor: DoctorTarget,
  ): BuildMachinesResult & { buildMachinesPending?: boolean; buildMachinesAt?: string } {
    if (doctor === null) return { buildMachines: [] };
    if ('error' in doctor) return { buildMachines: null, buildMachinesError: doctor.error };
    if (doctor.cwd === null) {
      return { buildMachines: null, buildMachinesError: 'no Stim workspace is registered to check them from' };
    }
    const cwd = doctor.cwd;
    const fresh = this.settled !== null && this.now() - this.settled.at < this.ttlMs;
    if (!fresh && !this.inflight) {
      this.inflight = runDoctor(run, cwd).then((result) => {
        this.settled = { result, at: this.now() };
        this.inflight = null;
        return undefined;
      });
    }
    if (!this.settled) return { buildMachines: null, buildMachinesPending: true };
    return {
      ...this.settled.result,
      buildMachinesAt: new Date(this.settled.at).toISOString(),
      ...(fresh ? {} : { buildMachinesPending: true }),
    };
  }
}

/** The `build` audit records grouped by client, most recent client first; `today` is `now`'s local calendar day. */
export function buildClients(records: AuditRecord[], now: number): BuildClientSummary[] {
  const day = new Date(now).toDateString();
  const clients = new Map<string, BuildClientSummary>();
  for (const record of records) {
    if (record.action !== 'build' || typeof record.device?.id !== 'string') continue;
    const durationMs =
      typeof record.durationMs === 'number' && record.durationMs > 0 ? Math.round(record.durationMs) : 0;
    const entry = clients.get(record.device.id) ?? {
      id: record.device.id,
      name: record.device.name,
      builds: 0,
      failed: 0,
      buildMs: 0,
      today: { builds: 0, failed: 0, buildMs: 0 },
      lastAt: record.at,
    };
    const failed = record.ok ? 0 : 1;
    entry.name = record.device.name;
    entry.builds += 1;
    entry.failed += failed;
    entry.buildMs += durationMs;
    entry.lastAt = record.at;
    if (new Date(record.at).toDateString() === day) {
      entry.today.builds += 1;
      entry.today.failed += failed;
      entry.today.buildMs += durationMs;
    }
    clients.set(record.device.id, entry);
  }
  return [...clients.values()].toSorted((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

export async function loadMachineDetails(
  run: (args: string[], cwd?: string) => Promise<CommandOutcome>,
  audit: () => Promise<AuditRecord[]>,
  readStats: () => Promise<CommandOutcome>,
): Promise<Omit<MachineDetails, 'buildMachines'>> {
  const measuredAt = new Date().toISOString();
  const [gc, stats, records] = await Promise.all([run(GC_DRY_RUN), readStats(), audit()]);
  const gcPart = part(gc, 'stim gc');
  const statsPart = part(stats, 'stim stats');
  return {
    gc: gcPart.payload,
    ...(gcPart.error ? { gcError: gcPart.error } : {}),
    stats: statsPart.payload,
    ...(statsPart.error ? { statsError: statsPart.error } : {}),
    buildClients: buildClients(records, Date.parse(measuredAt)),
    measuredAt,
  };
}

/**
 * The gc/stats part of one `machine.details` result shared by every connection: a request while a load runs joins
 * it, and a finished load answers for `ttlMs` after it settled, so phones cannot make the Mac run `stim gc` back
 * to back. Build machines are cached and refreshed separately by `BuildMachinesCache`, never joined into this
 * promise, so a re-poll observes its progress instead of the gc/stats snapshot from whenever this last loaded.
 */
export class MachineDetailsCache {
  private entry: { value: Promise<Omit<MachineDetails, 'buildMachines'>>; settledAt: number | null } | null = null;
  private readonly load: () => Promise<Omit<MachineDetails, 'buildMachines'>>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    load: () => Promise<Omit<MachineDetails, 'buildMachines'>>,
    ttlMs: number = MACHINE_DETAILS_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.load = load;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(): Promise<Omit<MachineDetails, 'buildMachines'>> {
    const current = this.entry;
    if (current && (current.settledAt === null || this.now() - current.settledAt < this.ttlMs)) return current.value;
    const next: { value: Promise<Omit<MachineDetails, 'buildMachines'>>; settledAt: number | null } = {
      value: this.load(),
      settledAt: null,
    };
    const settle = () => {
      next.settledAt = this.now();
    };
    next.value.then(settle, settle);
    this.entry = next;
    return next.value;
  }
}
