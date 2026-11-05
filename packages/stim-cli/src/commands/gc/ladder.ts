import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import {
  currentStage,
  readDormantStage,
  readIdleStage,
  type DaemonLadderAction,
  type DaemonPressure,
  type DaemonWorkspaceDecision,
} from '@stim-cli/core/state';
import { formatLongDuration } from '../../command-output.ts';
import { runForcedLadder } from '../../daemon/passes.ts';
import { ACTIVE_BUILD_KEY, activeBuildState, parseActiveBuild } from '../../engine/build-progress.ts';
import { formatBytes } from '../../fs-util.ts';
import { loadConfig } from '../../workspace/config.ts';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';
import type { GcOutput, GcResult } from './results.ts';

export type GcLadderLevel = 'high' | 'critical';

/** Where a registered workspace is: something of it runs, or the stage the daemon last moved it into. */
interface GcWorkspaceStage {
  path: string;
  stage: 'running' | 'idle' | 'dormant' | 'stopped';
  /** Its last activity while running, when the daemon staged it while idle or dormant, its last Stim command while stopped. */
  since: string | null;
  /** Why the idle stage leaves a running workspace whatever its activity, when something does. */
  kept?: string;
}

/** What `stim gc` reports of the pressure ladder: the level now, what each level would do, and each workspace's stage. */
export interface GcLadder {
  pressure: DaemonPressure;
  levels: {
    level: GcLadderLevel;
    command: string;
    actions: DaemonLadderAction[];
  }[];
  workspaces: GcWorkspaceStage[];
}

const GC_WHY = 'stim gc --delete';

/** `stim gc --delete` runs the ladder's high level; with `--cache all` its critical level, node_modules and Pods included. */
export function gcLadderLevel(cache: string | null): GcLadderLevel {
  return cache?.trim().toLowerCase() === 'all' ? 'critical' : 'high';
}

const COMMANDS: Record<GcLadderLevel, string> = {
  high: 'stim gc --delete',
  critical: 'stim gc --delete --cache all',
};

function workspaceStages(paths: readonly string[], running: readonly DaemonWorkspaceDecision[]): GcWorkspaceStage[] {
  return paths.map((path) => {
    const decision = running.find((entry) => entry.path === path);
    if (decision)
      return {
        path,
        stage: 'running',
        since: decision.lastActivity?.at ?? null,
        ...(decision.outcome === 'kept' ? { kept: decision.detail } : {}),
      };
    const state = readWorkspaceState(path);
    const build = parseActiveBuild(state?.[ACTIVE_BUILD_KEY]);
    if (build && activeBuildState(build.claim) === 'running') return { path, stage: 'running', since: null };
    const dormant = currentStage(state, readDormantStage(state));
    if (dormant) return { path, stage: 'dormant', since: dormant.at };
    const idle = currentStage(state, readIdleStage(state));
    if (idle) return { path, stage: 'idle', since: idle.at };
    return {
      path,
      stage: 'stopped',
      since: typeof state?.lastUsedAt === 'string' ? state.lastUsedAt : null,
    };
  });
}

/** What the ladder would do now at high and at critical, with sizes, and each registered workspace's stage. */
export async function previewGcLadder(olderThan: number | null, operation?: StimContext): Promise<GcLadder | null> {
  const preview = await runForcedLadder({
    levels: ['high', 'critical'],
    act: false,
    why: GC_WHY,
    trigger: 'gc',
    ...(olderThan === null ? {} : { parkedOlderThanDays: olderThan }),
    operation,
  });
  if (!preview) return null;
  return {
    pressure: preview.pressure,
    levels: preview.levels.map(({ level, actions }) => ({
      level,
      command: COMMANDS[level],
      actions,
    })),
    workspaces: workspaceStages(Object.keys(loadConfig()?.projects ?? {}), preview.running),
  };
}

const RESULT_KINDS: Record<string, GcResult['kind']> = {
  'idle-stage': 'devServer',
  'delete-build-outputs': 'workspaceOutputs',
  'delete-parked-device': 'parkedDevice',
  'trim-cache': 'cache',
  'empty-cache': 'cache',
  'dormant-stage': 'device',
  'delete-dependencies': 'worktreeDependencies',
  'stop-gradle-daemons': 'gradleDaemon',
  'stop-watchman': 'watchman',
  'delete-gradle-version': 'gradleVersion',
  'delete-temp-leftovers': 'tempLeftover',
  'delete-trash': 'trash',
};

function actionWords(action: DaemonLadderAction): string {
  return `rung ${action.rung} ${action.kind.replaceAll('-', ' ')} ${action.target}`;
}

/** Runs the ladder to its end at `level` now, whatever the level the machine measures; returns the failures. */
export async function runGcLadder(
  level: GcLadderLevel,
  olderThan: number | null,
  output: GcOutput,
  operation?: StimContext,
): Promise<number> {
  output.log(chalk.bold(`Pressure ladder at ${level}, whatever the machine measures:`));
  const ran = await runForcedLadder({
    levels: [level],
    act: true,
    why: GC_WHY,
    trigger: 'gc',
    ...(olderThan === null ? {} : { parkedOlderThanDays: olderThan }),
    operation,
  });
  if (!ran) return 0;
  const actions = ran.levels.flatMap((entry) => entry.actions);
  let failures = 0;
  for (const action of actions) {
    const status = action.outcome === 'would' ? 'kept' : action.outcome;
    output.record(RESULT_KINDS[action.kind] ?? 'cache', status, action.target, {
      bytes: action.bytes,
      detail: action.detail,
    });
    if (status === 'done')
      output.log(
        chalk.green(
          `  ${actionWords(action)}: ${formatBytes(action.bytes)} freed${action.restore ? `; restore with ${action.restore}` : ''}`,
        ),
      );
    else if (status === 'kept') output.log(chalk.dim(`  kept ${action.target}: ${action.detail}`));
    else {
      failures++;
      output.log(chalk.red(`  ${actionWords(action)} failed: ${action.detail}`));
    }
  }
  if (!actions.length) output.log(chalk.dim(`  nothing to take at ${level}`));
  return failures;
}

const STAGE_WORDS: Record<GcWorkspaceStage['stage'], string> = {
  running: 'running, last activity',
  idle: 'idle',
  dormant: 'dormant',
  stopped: 'stopped, last Stim command',
};

/** The plain report of the ladder: the level now, each level's actions with sizes, and each workspace's stage. */
export function gcLadderLines(ladder: GcLadder | null | undefined, now: number = Date.now()): string[] {
  if (!ladder) return [];
  const { pressure } = ladder;
  const lines = [
    `Pressure ladder (level now: ${pressure.level}${pressure.reasons.length ? `; ${pressure.reasons.join('; ')}` : ''}):`,
  ];
  for (const { level, command, actions } of ladder.levels) {
    const total = actions.reduce((sum, action) => sum + action.bytes, 0);
    lines.push(
      `  at ${level}, as \`${command}\` runs it now: ${actions.length ? `about ${formatBytes(total)}` : 'nothing to take'}`,
    );
    for (const action of actions)
      lines.push(
        `    ${formatBytes(action.bytes).padStart(10)}  rung ${action.rung} ${action.kind.replaceAll('-', ' ')} ${action.target}${action.outcome === 'kept' ? ` (kept: ${action.detail})` : ''}`,
      );
  }
  if (ladder.workspaces.length) {
    lines.push('Workspace stages:');
    for (const entry of ladder.workspaces) {
      const at = Date.parse(entry.since ?? '');
      const age = Number.isFinite(at) ? ` ${formatLongDuration(Math.max(0, now - at))} ago` : '';
      const since =
        entry.stage === 'idle' || entry.stage === 'dormant' ? (age ? ` for${age.replace(/ ago$/, '')}` : '') : age;
      lines.push(`  ${entry.path}: ${STAGE_WORDS[entry.stage]}${since}${entry.kept ? `; kept: ${entry.kept}` : ''}`);
    }
  }
  return lines;
}
