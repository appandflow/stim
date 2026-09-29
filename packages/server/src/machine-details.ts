import type { ProjectRecord, StimConfig } from '@stim-cli/core/state';
import type { BuildMachineReport, MachineDetails } from './protocol.ts';
import type { CommandOutcome } from './stim-command.ts';

/**
 * The only commands `machine.details` runs. Any other `gc` flag either deletes or drops the device and runtime
 * inventory from the payload.
 */
const GC_DRY_RUN = ['gc', '--json'];
const STATS = ['stats', '--json'];
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

async function buildMachinesPart(
  run: (args: string[], cwd?: string) => Promise<CommandOutcome>,
  doctor: DoctorTarget,
): Promise<{ buildMachines: BuildMachineReport[] | null; buildMachinesError?: string }> {
  if (doctor === null) return { buildMachines: [] };
  if ('error' in doctor) return { buildMachines: null, buildMachinesError: doctor.error };
  if (doctor.cwd === null) {
    return { buildMachines: null, buildMachinesError: 'no Stim workspace is registered to check them from' };
  }
  const { payload, error } = part(await run(DOCTOR, doctor.cwd), 'stim doctor');
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

export async function loadMachineDetails(
  run: (args: string[], cwd?: string) => Promise<CommandOutcome>,
  doctor: DoctorTarget = null,
): Promise<MachineDetails> {
  const measuredAt = new Date().toISOString();
  const [gc, stats, machines] = await Promise.all([run(GC_DRY_RUN), run(STATS), buildMachinesPart(run, doctor)]);
  const gcPart = part(gc, 'stim gc');
  const statsPart = part(stats, 'stim stats');
  return {
    gc: gcPart.payload,
    ...(gcPart.error ? { gcError: gcPart.error } : {}),
    stats: statsPart.payload,
    ...(statsPart.error ? { statsError: statsPart.error } : {}),
    ...machines,
    measuredAt,
  };
}

/**
 * One `machine.details` result shared by every connection: a request while a load runs joins it, and a finished
 * load answers for `ttlMs` after it settled, so phones cannot make the Mac run `stim gc` back to back.
 */
export class MachineDetailsCache {
  private entry: { value: Promise<MachineDetails>; settledAt: number | null } | null = null;
  private readonly load: () => Promise<MachineDetails>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    load: () => Promise<MachineDetails>,
    ttlMs: number = MACHINE_DETAILS_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.load = load;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(): Promise<MachineDetails> {
    const current = this.entry;
    if (current && (current.settledAt === null || this.now() - current.settledAt < this.ttlMs)) return current.value;
    const next: { value: Promise<MachineDetails>; settledAt: number | null } = { value: this.load(), settledAt: null };
    const settle = () => {
      next.settledAt = this.now();
    };
    next.value.then(settle, settle);
    this.entry = next;
    return next.value;
  }
}
