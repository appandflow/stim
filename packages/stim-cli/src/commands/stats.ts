import chalk from 'chalk';
import type { Command } from 'commander';
import { formatLongDuration } from '../command-output.ts';
import { offloadSummary, readStats, statsProjectKey, STATS_VERSION } from '../engine/stats.ts';
import type { OffloadSummary, StatsBucket, StatsPlatform, StatsScope } from '../engine/stats.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';

const PLATFORMS: StatsPlatform[] = ['ios', 'android'];
const PLATFORM_WIDTH = 9;
const RECENT_PLACEMENTS = 5;

interface StatsOptions {
  json?: boolean;
}

export default function statsCommand(program: Command): void {
  program
    .command('stats')
    .description(
      'Show how many `ios` and `android` runs this project and this machine have recorded, how many hit the build ' +
        'cache, and an estimate of the time that cache saved.',
    )
    .option('--json', 'print the aggregates as JSON')
    .action((opts: StatsOptions) => {
      const root = findProjectRoot(process.cwd());
      const key = root
        ? statsProjectKey({
            root,
            commonDir: gitCommonDir(root),
            repoRoot: repoRoot(root),
          })
        : null;
      const { record, note } = readStats();
      if (note) console.error(chalk.dim(note));
      const machine: StatsScope = record?.machine ?? {};
      const project: StatsScope = key ? (record?.projects?.[key] ?? {}) : {};
      const offload = offloadSummary(record, Date.now());

      if (opts.json) {
        console.log(
          JSON.stringify({
            version: STATS_VERSION,
            project: key
              ? {
                  key,
                  ios: project.ios ?? null,
                  android: project.android ?? null,
                }
              : null,
            machine: {
              ios: machine.ios ?? null,
              android: machine.android ?? null,
            },
            offload,
          }),
        );
        return;
      }

      const lines: string[] = [];
      if (key) lines.push(`project ${key}`, ...sectionLines(project));
      lines.push('machine', ...sectionLines(machine));
      if (offload.placements.length || Object.keys(offload.machines).length) lines.push(...placementLines(offload));
      for (const line of lines) console.log(line);
    });
}

function sectionLines(scope: StatsScope): string[] {
  const lines = PLATFORMS.filter((platform) => scope[platform]).map((platform) =>
    bucketLine(platform, scope[platform] as StatsBucket),
  );
  return lines.length ? lines : [chalk.dim('  no runs recorded')];
}

function placementLines(offload: OffloadSummary): string[] {
  const { here, offloaded, fellBack } = offload.today;
  const lines = [
    'build placement',
    `  ${'today'.padEnd(PLATFORM_WIDTH)}${here} here, ${offloaded} offloaded, ${fellBack} fell back`,
  ];
  for (const [name, { today, total }] of Object.entries(offload.machines)) {
    const saved =
      total.savedMs === 0
        ? ''
        : `, ${total.savedMs > 0 ? 'saved' : 'lost'} ~${formatLongDuration(Math.abs(total.savedMs))} (estimated)`;
    lines.push(
      `  ${name}: today ${today.offloaded} offloaded, ${today.fallbacks} fell back; ` +
        `total ${total.offloaded} offloaded (${average(total.offloadedMs, total.offloaded)} avg)${saved}, ${total.fallbacks} fell back`,
    );
  }
  for (const placement of offload.placements.slice(0, RECENT_PLACEMENTS)) {
    const where = placement.decision === 'here' ? 'here' : `${placement.decision} ${placement.machine ?? ''}`.trim();
    lines.push(
      chalk.dim(
        `  ${placement.at.slice(0, 16).replace('T', ' ')}Z ${placement.platform} ${where}: ${placement.reason}`,
      ),
    );
  }
  return lines;
}

function bucketLine(platform: string, bucket: StatsBucket): string {
  const finished = bucket.runs - bucket.failed;
  const cells = [
    `${bucket.runs} runs${bucket.failed > 0 ? ` (${bucket.failed} failed)` : ''}`,
    `${bucket.hits} hits (${finished > 0 ? `${Math.round((bucket.hits / finished) * 100)}%` : '-'})`,
    `cold run ${average(bucket.coldRunMs, bucket.coldRuns)} avg`,
    `hit run ${average(bucket.hitRunMs, bucket.hitRuns)} avg`,
    ...(bucket.offloadedRuns
      ? [
          `offloaded run ${average(bucket.offloadedRunMs ?? 0, bucket.offloadedRuns)} avg (${bucket.offloadedRuns}, last on ${bucket.lastOffloadHost ?? '?'})`,
        ]
      : []),
    `saved ~${formatLongDuration(bucket.timeSavedMs)} (estimated)`,
    `since ${bucket.firstRunAt.slice(0, 10)}`,
  ];
  return `  ${platform.padEnd(PLATFORM_WIDTH)}${cells.join('   ')}`;
}

function average(totalMs: number, runs: number): string {
  return runs > 0 ? formatLongDuration(Math.round(totalMs / runs)) : '-';
}
