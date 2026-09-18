import { getProject, clearSupervisor } from '../config.ts';
import { killMetroTree, resolveProjectMetro } from '../metro.ts';
import { waitForProcessExit } from '../process-identity.ts';
import { resolveSupervisorTarget } from './ownership.ts';
import { clearWorkspaceSupervisor } from './state.ts';
import { readWorkspaceState } from '../workspace-state.ts';
import { supervisorError } from './errors.ts';

export async function stopOwnedMetroForReset(root: string): Promise<void> {
  const project = getProject(root);
  const port = project?.metroPort;
  const target = resolveSupervisorTarget({
    state: readWorkspaceState(root)?.supervisor,
    record: project?.supervisor,
    reservedPort: port,
  });
  if (target.status === 'unverified') {
    throw supervisorError(
      'STIM_SUPERVISOR_EXITED',
      `Cannot reset Metro: ${target.reason}.`,
      'Stop it with the tool that started it, then retry. Stim leaves unverified processes alone.',
    );
  }
  if (port && target.status !== 'ours' && !(await resolveProjectMetro(port, root)).missing) {
    throw supervisorError(
      'STIM_SUPERVISOR_EXITED',
      'Cannot reset an externally started dev server.',
      'Stop it with the tool that started it, then retry `stim start --reset-cache`.',
    );
  }
  if (target.status === 'ours') {
    const expected = { pid: target.pid, processToken: target.processToken };
    if (!killMetroTree(target.pid, target.processToken) || !(await waitForProcessExit(expected, 10_000))) {
      throw supervisorError(
        'STIM_SUPERVISOR_EXITED',
        'The owned Metro supervisor could not be stopped for a cache reset.',
        'Inspect `stim status` and `stim logs`, then retry. No cache reset was recorded.',
      );
    }
    if (port && !(await resolveProjectMetro(port, root)).missing) {
      throw supervisorError(
        'STIM_SUPERVISOR_EXITED',
        `Port ${port} is still occupied after stopping Metro.`,
        'Inspect the listener before retrying. Stim does not terminate unrecorded processes.',
      );
    }
    clearWorkspaceSupervisor(root, expected);
    clearSupervisor(root, expected);
  }
}
