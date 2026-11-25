import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BUILD_AREAS_KEY,
  isJsonObject,
  readBuildAreas,
  readBuildMachines,
  readWorkspaceState,
  type BuildAreaRecord,
} from '@stim-cli/core/state';
import { debugLog } from '../debug-log.ts';
import { updateWorkspaceState } from '../workspace/workspace-state.ts';

const DROP_DEADLINE_MS = 5_000;
const QUIET_SKIP_MS = 10 * 60_000;

/** Workers that could not be reached or did not answer in time, skipped by this process until the time noted. */
const quietUntil = new Map<string, number>();

const same = (a: BuildAreaRecord, b: BuildAreaRecord): boolean =>
  a.machine === b.machine && a.repo === b.repo && a.checkout === b.checkout && a.device === b.device;

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

/**
 * Records that `workspace`'s checkout, which exists now, went to a build worker. A write that fails costs only that
 * worker's drop.
 */
export function recordBuildArea(workspace: string, area: Omit<BuildAreaRecord, 'device'>): void {
  try {
    const record = { ...area, device: statSync(area.checkout).dev };
    if (readBuildAreas(readWorkspaceState(workspace)).some((each) => same(each, record))) return;
    updateWorkspaceState(workspace, (state) => {
      const areas = readBuildAreas(state);
      return areas.some((each) => same(each, record)) ? state : { ...state, [BUILD_AREAS_KEY]: [...areas, record] };
    });
  } catch (error) {
    debugLog.log('build_area_record_failed', { machine: area.machine, msg: String(error) });
  }
}

/**
 * Whether the checkout is proven gone: it is absent and its nearest existing ancestor is on the volume that held it,
 * so an unmounted volume, whose mount point then sits on its parent's volume, never counts as a removal.
 */
function checkoutGone({ checkout, device }: BuildAreaRecord): boolean {
  try {
    statSync(checkout);
    return false;
  } catch (error) {
    if (!missing(error)) return false;
  }
  for (let dir = dirname(checkout); ; dir = dirname(dir)) {
    try {
      return statSync(dir).dev === device;
    } catch (error) {
      if (!missing(error) || dirname(dir) === dir) return false;
    }
  }
}

export type BuildAreaDrop = BuildAreaRecord & ({ dropped: true } | { kept: string } | { skipped: string });

/**
 * Asks each recorded worker to drop the area of a checkout whose folder is proven gone, in parallel and within one
 * short deadline. Best effort: an unreachable worker, one older than `build.area.drop`, and any refusal or timeout
 * are skipped, and that worker's `server.workerAreaMaxAgeDays` removes the area instead. A worker that could not be
 * reached or did not answer in time is not asked again for 10 minutes, so a gc pass that removes many worktrees waits
 * for it once.
 */
export async function dropBuildAreas(
  records: readonly BuildAreaRecord[],
  signal?: AbortSignal,
): Promise<BuildAreaDrop[]> {
  // @ref LLP 0009#repository-ownership-and-cleanup -- a removed checkout asks its workers to drop its area, best effort
  if (!records.length || signal?.aborted) return [];
  try {
    return await askWorkers(records, signal);
  } catch (error) {
    debugLog.log('build_area_drop_failed', { msg: String(error) });
    return [];
  }
}

async function askWorkers(records: readonly BuildAreaRecord[], signal?: AbortSignal): Promise<BuildAreaDrop[]> {
  const gone = records.filter(
    (each, at) => records.findIndex((other) => same(other, each)) === at && checkoutGone(each),
  );
  if (!gone.length) return [];
  const credentials = readBuildMachines().filter((each) => each.state === 'approved');
  const [{ BuildConnection }, { resolveEndpoint }] = await Promise.all([
    import('./client.ts'),
    import('./build-machines.ts'),
  ]);
  const deadline = new AbortController();
  const stop = () => deadline.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, DROP_DEADLINE_MS);
  const timedOut = new Promise<'deadline'>((resolve) =>
    deadline.signal.addEventListener('abort', () => resolve('deadline'), { once: true }),
  );
  const late = (record: BuildAreaRecord): BuildAreaDrop => {
    quietUntil.set(record.machine, Date.now() + QUIET_SKIP_MS);
    return { ...record, skipped: 'it did not answer in time' };
  };
  const drop = async (record: BuildAreaRecord): Promise<BuildAreaDrop> => {
    const credential = credentials.find((each) => each.machine === record.machine);
    const serverKey = credential?.serverKey;
    if (!credential || !serverKey) return { ...record, skipped: 'it is no longer paired for builds' };
    if ((quietUntil.get(record.machine) ?? 0) > Date.now())
      return { ...record, skipped: 'it did not answer a recent request' };
    const target = await resolveEndpoint(credential, undefined, deadline.signal);
    if (typeof target === 'string') return { ...record, skipped: target };
    const connection = await BuildConnection.open(target, serverKey, DROP_DEADLINE_MS, 'build', deadline.signal);
    if (!(connection instanceof BuildConnection)) {
      if (deadline.signal.aborted) return late(record);
      if (!connection.refused) quietUntil.set(record.machine, Date.now() + QUIET_SKIP_MS);
      return { ...record, skipped: connection.failure };
    }
    try {
      if (deadline.signal.aborted) return late(record);
      if (!checkoutGone(record)) return { ...record, skipped: 'its checkout is back' };
      const answer = await Promise.race([
        connection.request('build.area.drop', { repo: record.repo }, DROP_DEADLINE_MS),
        timedOut,
      ]);
      if (answer === 'deadline') return late(record);
      if ('error' in answer) return { ...record, skipped: `${answer.error.code}: ${answer.error.message}` };
      const result = isJsonObject(answer.result) ? answer.result : {};
      if (result.dropped === true) return { ...record, dropped: true };
      return typeof result.kept === 'string' ? { ...record, kept: result.kept } : { ...record, skipped: 'no area' };
    } finally {
      connection.close();
    }
  };
  try {
    const outcomes = await Promise.all(
      gone.map((record) =>
        Promise.race([drop(record), timedOut]).then(
          (outcome): BuildAreaDrop => (outcome === 'deadline' ? late(record) : outcome),
          (error: unknown): BuildAreaDrop => ({ ...record, skipped: String(error) }),
        ),
      ),
    );
    for (const outcome of outcomes) debugLog.log('build_area_drop', { ...outcome });
    return outcomes;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
