import type { DaemonLadderAction, DaemonPressure, MaintenanceAction, PressureLevel } from '@stim-cli/core/state';
import { executedActionName } from '../../maintenance-kind.ts';
import type { ActionOutcome } from './act.ts';
import type { LevelRun, LevelRunAction } from './level-run.ts';

export function fromOutcome(action: MaintenanceAction, outcome: ActionOutcome): LevelRunAction {
  return {
    rung: null,
    kind: executedActionName(action),
    target: action.target,
    ...(action.workspace ? { workspace: action.workspace } : {}),
    outcome: outcome.status,
    bytes: outcome.bytes,
    ...(outcome.partial ? { partial: outcome.partial } : {}),
    reason: action.reason,
    detail: outcome.detail,
    ...(outcome.restore ? { restore: outcome.restore } : {}),
  };
}

export function fromLadder(action: DaemonLadderAction, dormant = false): LevelRunAction {
  return {
    rung: dormant ? null : action.rung,
    kind: action.kind,
    target: action.target,
    ...(action.workspace ? { workspace: action.workspace } : {}),
    outcome: action.outcome,
    bytes: action.bytes,
    ...(action.partial ? { partial: action.partial } : {}),
    reason: dormant ? `no activity for ${action.setting ?? 'idle.dormantDays'}` : `pressure ladder rung ${action.rung}`,
    detail: action.detail,
    ...(action.restore ? { restore: action.restore } : {}),
  };
}

/** A disk pass of the tick as the maintenance run a gc request that joined it reports. */
export function ladderRun(level: PressureLevel, pressure: DaemonPressure, actions: DaemonLadderAction[]): LevelRun {
  return {
    pressure,
    level,
    actions: actions.map((action) => fromLadder(action)),
    blocked: [],
    discovered: [],
    outside: [],
    usage: [],
    cachePaths: [],
    sweptCachePaths: [],
  };
}
