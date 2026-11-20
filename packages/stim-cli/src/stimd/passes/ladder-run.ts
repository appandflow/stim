import type { DaemonLadderAction, DaemonPressure, PressureLevel } from '@stim-cli/core/state';
import type { LevelRun, LevelRunAction } from './level-run.ts';

export function fromLadder(action: DaemonLadderAction, dormant = false): LevelRunAction {
  return {
    rung: dormant ? null : action.rung,
    kind: action.kind,
    target: action.target,
    ...(action.workspace ? { workspace: action.workspace } : {}),
    outcome: action.outcome,
    bytes: action.bytes,
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
