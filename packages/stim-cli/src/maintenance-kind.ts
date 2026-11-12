import type { MaintenanceAction } from '@stim-cli/core/state';

/**
 * The name gc results, summaries and logs give an action: its kind without `would-`, except the Cargo target trim,
 * which reuses `would-clear-build-dirs` and carries its workspace.
 */
export function executedActionName(action: Pick<MaintenanceAction, 'kind' | 'workspace'>): string {
  return action.kind === 'would-clear-build-dirs' && action.workspace
    ? 'trim-cargo-target'
    : action.kind.replace(/^would-/, '');
}
