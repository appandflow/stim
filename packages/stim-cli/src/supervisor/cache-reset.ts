import { getProject, clearSupervisor, withConfigLockAsync } from '../workspace/config.ts';
import { killMetroTreeAsync, listeningPidsAsync, processCwds, resolveProjectMetro } from '../metro.ts';
import { isMetroRunning } from '../ports.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { waitForProcessExit } from '../process-identity.ts';
import { resolveSupervisorTarget } from './ownership.ts';
import { clearWorkspaceSupervisor } from './state.ts';
import { readWorkspaceState, withWorkspaceStateLockAsync } from '../workspace/workspace-state.ts';
import { supervisorError } from './errors.ts';
import { requestDevServerStop, withdrawDevServerStopRequest, type StopRequester } from './stop-cause.ts';

export type OwnedMetroStop =
  | { status: 'stopped' | 'not-running' }
  | { status: 'unverified' | 'external' | 'stuck' | 'port-occupied'; reason: string };

export async function stopOwnedMetro(
  root: string,
  requester: StopRequester,
  signal?: AbortSignal,
): Promise<OwnedMetroStop> {
  const resolve = async (port: number, probeSignal?: AbortSignal) => {
    throwIfCancelled(probeSignal, 'Metro reset');
    const result = await resolveProjectMetro(port, root, {
      pidsOf: (candidate) => listeningPidsAsync(candidate, process.platform, probeSignal),
      cwdOf: async (pid) => (await processCwds([pid], probeSignal)).get(pid) ?? null,
      probe: (candidate) => isMetroRunning(candidate, probeSignal),
    });
    throwIfCancelled(probeSignal, 'Metro reset');
    return result;
  };
  throwIfCancelled(signal, 'Metro reset');
  const project = getProject(root);
  const port = project?.metroPort;
  const target = resolveSupervisorTarget({
    state: readWorkspaceState(root)?.supervisor,
    record: project?.supervisor,
    reservedPort: port,
  });
  if (target.status === 'unverified') return { status: 'unverified', reason: target.reason ?? 'unknown identity' };
  if (port && target.status !== 'ours' && !(await resolve(port, signal)).missing) {
    return { status: 'external', reason: `a dev server Stim did not start answers on port ${port}` };
  }
  if (target.status !== 'ours') return { status: 'not-running' };
  const expected = { pid: target.pid, processToken: target.processToken };
  await withWorkspaceStateLockAsync(root, () => requestDevServerStop(root, target.processToken, requester), signal);
  const signalled = await killMetroTreeAsync(target.pid, target.processToken);
  if (!signalled)
    await withWorkspaceStateLockAsync(root, () => withdrawDevServerStopRequest(root, target.processToken));
  if (!signalled || !(await waitForProcessExit(expected, 10_000))) {
    return { status: 'stuck', reason: `supervisor pid ${target.pid} did not exit` };
  }
  if (port && !(await resolve(port)).missing) {
    return { status: 'port-occupied', reason: `port ${port} is still occupied after stopping Metro` };
  }
  await withWorkspaceStateLockAsync(root, () => clearWorkspaceSupervisor(root, expected));
  await withConfigLockAsync(() => clearSupervisor(root, expected));
  throwIfCancelled(signal, 'Metro reset');
  return { status: 'stopped' };
}

export async function stopOwnedMetroForReset(root: string, signal?: AbortSignal): Promise<void> {
  const stopped = await stopOwnedMetro(root, { by: 'stim start --reset-cache' }, signal);
  switch (stopped.status) {
    case 'unverified':
      throw supervisorError(
        'STIM_SUPERVISOR_EXITED',
        `Cannot reset Metro: ${stopped.reason}.`,
        'Stop it with the tool that started it, then retry. Stim leaves unverified processes alone.',
      );
    case 'external':
      throw supervisorError(
        'STIM_SUPERVISOR_EXITED',
        'Cannot reset an externally started dev server.',
        'Stop it with the tool that started it, then retry `stim start --reset-cache`.',
      );
    case 'stuck':
      throw supervisorError(
        'STIM_SUPERVISOR_EXITED',
        'The owned Metro supervisor could not be stopped for a cache reset.',
        'Inspect `stim status` and `stim logs`, then retry. No cache reset was recorded.',
      );
    case 'port-occupied':
      throw supervisorError(
        'STIM_SUPERVISOR_EXITED',
        `Port ${getProject(root)?.metroPort} is still occupied after stopping Metro.`,
        'Inspect the listener before retrying. Stim does not terminate unrecorded processes.',
      );
  }
}
