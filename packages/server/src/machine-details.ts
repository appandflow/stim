import type { MachineDetails } from './protocol.ts';
import type { CommandOutcome } from './stim-command.ts';

/**
 * The only commands `machine.details` runs. Any other `gc` flag either deletes or drops the device and runtime
 * inventory from the payload.
 */
const GC_DRY_RUN = ['gc', '--json'];
const STATS = ['stats', '--json'];

const MACHINE_DETAILS_TTL_MS = 60_000;

function part(outcome: CommandOutcome, label: string): { payload: Record<string, unknown> | null; error?: string } {
  if (!outcome.ok) return { payload: null, error: outcome.message };
  try {
    const value: unknown = JSON.parse(outcome.stdout);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { payload: value as Record<string, unknown> };
    }
  } catch {}
  return { payload: null, error: `${label} printed output that is not a JSON object.` };
}

/** Runs the gc dry run and stats side by side; a failing part leaves the other intact. */
export async function loadMachineDetails(run: (args: string[]) => Promise<CommandOutcome>): Promise<MachineDetails> {
  const measuredAt = new Date().toISOString();
  const [gc, stats] = await Promise.all([run(GC_DRY_RUN), run(STATS)]);
  const gcPart = part(gc, 'stim gc');
  const statsPart = part(stats, 'stim stats');
  return {
    gc: gcPart.payload,
    ...(gcPart.error ? { gcError: gcPart.error } : {}),
    stats: statsPart.payload,
    ...(statsPart.error ? { statsError: statsPart.error } : {}),
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
