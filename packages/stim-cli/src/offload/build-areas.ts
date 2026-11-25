import {
  BUILD_AREAS_KEY,
  isJsonObject,
  readBuildAreas,
  readBuildMachines,
  readWorkspaceState,
  type BuildAreaRecord,
} from '@stim-cli/core/state';
import { debugLog } from '../debug-log.ts';
import { isAbsentPath, isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { updateWorkspaceState } from '../workspace/workspace-state.ts';

const DROP_DEADLINE_MS = 5_000;

const same = (a: BuildAreaRecord, b: BuildAreaRecord): boolean =>
  a.machine === b.machine && a.repo === b.repo && a.checkout === b.checkout;

/** Records that `workspace`'s checkout went to a build worker. A write that fails costs only that worker's drop. */
export function recordBuildArea(workspace: string, record: BuildAreaRecord): void {
  try {
    if (readBuildAreas(readWorkspaceState(workspace)).some((each) => same(each, record))) return;
    updateWorkspaceState(workspace, (state) => {
      const areas = readBuildAreas(state);
      return areas.some((each) => same(each, record)) ? state : { ...state, [BUILD_AREAS_KEY]: [...areas, record] };
    });
  } catch (error) {
    debugLog.log('build_area_record_failed', { machine: record.machine, msg: String(error) });
  }
}

/** The build areas the workspaces `keys` recorded, read before their removal deletes the records. */
export function recordedBuildAreas(keys: readonly string[]): BuildAreaRecord[] {
  const areas: BuildAreaRecord[] = [];
  for (const key of keys) {
    for (const record of readBuildAreas(readWorkspaceState(key)))
      if (!areas.some((each) => same(each, record))) areas.push(record);
  }
  return areas;
}

export type BuildAreaDrop = BuildAreaRecord & ({ dropped: true } | { kept: string } | { skipped: string });

/**
 * Asks each recorded worker to drop the area of a checkout whose folder is proven gone, in parallel and within one
 * short deadline. Best effort: an unreachable worker, one older than `build.area.drop`, and any refusal or timeout
 * are skipped, and that worker's `server.workerAreaMaxAgeDays` removes the area instead.
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
  const mounted = listMountedVolumes();
  const gone = records.filter((each) => isAbsentPath(each.checkout) && isOnMountedVolume(each.checkout, mounted));
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
  const drop = async (record: BuildAreaRecord): Promise<BuildAreaDrop> => {
    const credential = credentials.find((each) => each.machine === record.machine);
    const serverKey = credential?.serverKey;
    if (!credential || !serverKey) return { ...record, skipped: 'it is no longer paired for builds' };
    const target = await resolveEndpoint(credential, undefined, deadline.signal);
    if (typeof target === 'string') return { ...record, skipped: target };
    const connection = await BuildConnection.open(target, serverKey, DROP_DEADLINE_MS, 'build', deadline.signal);
    if (!(connection instanceof BuildConnection)) return { ...record, skipped: connection.failure };
    try {
      const answer = await Promise.race([
        connection.request('build.area.drop', { repo: record.repo }, DROP_DEADLINE_MS),
        timedOut,
      ]);
      if (answer === 'deadline') return { ...record, skipped: 'it did not answer in time' };
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
          (outcome): BuildAreaDrop =>
            outcome === 'deadline' ? { ...record, skipped: 'it did not answer in time' } : outcome,
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
