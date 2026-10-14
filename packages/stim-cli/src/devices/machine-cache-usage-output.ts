import chalk from 'chalk';
import { formatBytes } from '../fs-util.ts';
import { formatLongDuration } from '../command-output.ts';
import type { MachineCacheReport } from './machine-cache-usage.ts';

const size = (bytes: number | null) => (bytes === null ? 'unknown' : formatBytes(bytes));

function total(values: (number | null)[]): string {
  const known = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return `${values.some((value) => value === null) ? 'at least ' : ''}${formatBytes(known)}`;
}

export function machineCacheLines(report: MachineCacheReport | null | undefined, now: number = Date.now()): string[] {
  if (!report) return [];
  const { gradle, simRuntimes, deviceSupport, runnerBuilds } = report;
  const body: string[] = [];
  if (gradle.unusedVersions.length) {
    body.push(
      `  Gradle versions no registered project pins (${total(gradle.unusedVersions.map((entry) => entry.bytes))}):`,
    );
    for (const entry of gradle.unusedVersions) {
      body.push(`    ${entry.version}: ${size(entry.bytes)}`);
      for (const dir of entry.dirs) body.push(`      ${dir.dir}`);
      body.push(chalk.dim(`      remedy: ${entry.remedy}`));
    }
    if (gradle.unreadableProjects.length)
      body.push(
        chalk.dim(
          `    ${gradle.unreadableProjects.length} registered project${gradle.unreadableProjects.length === 1 ? ' is' : 's are'} missing, so a version listed here may still be in use: ${gradle.unreadableProjects.join(', ')}`,
        ),
      );
  }
  if (gradle.modules) {
    body.push(`  Gradle dependency cache: ${size(gradle.modules.bytes)}`, `    ${gradle.modules.dir}`);
    body.push(chalk.dim(`    remedy: ${gradle.modules.remedy}`));
  }
  if (!simRuntimes.checked) {
    body.push(chalk.dim('  Simulator runtimes: not checked, simctl did not answer'));
  } else if (simRuntimes.runtimes.length) {
    body.push(`  Simulator runtimes (${total(simRuntimes.runtimes.map((entry) => entry.bytes))}):`);
    for (const runtime of simRuntimes.runtimes) {
      const details = [
        runtime.devices ? `${runtime.devices} simulator${runtime.devices === 1 ? '' : 's'}` : 'no simulator uses it',
        runtime.lastUsedAt ? `last used ${runtime.lastUsedAt.slice(0, 10)}` : null,
        runtime.deletable ? null : 'not deletable',
      ].filter(Boolean);
      body.push(
        `    ${runtime.runtimeIdentifier.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '')}${runtime.build ? ` (${runtime.build})` : ''}: ${size(runtime.bytes)}, ${details.join(', ')}`,
      );
      if (runtime.remedy) body.push(chalk.dim(`      remedy: ${runtime.remedy}`));
    }
  }
  if (deviceSupport.entries.length) {
    body.push(`  Xcode device support (${total(deviceSupport.entries.map((entry) => entry.bytes))}):`);
    for (const entry of deviceSupport.entries) body.push(`    ${entry.dir}: ${size(entry.bytes)}`);
    body.push(chalk.dim(`    remedy: ${deviceSupport.remedy}`));
  }
  if (runnerBuilds.groups.length) {
    const currentVersions =
      runnerBuilds.agentDeviceVersion && runnerBuilds.xcodeBuildVersion
        ? `current: agent-device ${runnerBuilds.agentDeviceVersion}, Xcode ${runnerBuilds.xcodeBuildVersion}`
        : 'current versions unknown';
    body.push(`  agent-device runner builds by version (${currentVersions}):`);
    for (const group of runnerBuilds.groups) {
      const details = [
        `${group.entries} entr${group.entries === 1 ? 'y' : 'ies'}`,
        size(group.bytes),
        group.oldestUseAt ? `oldest use ${group.oldestUseAt.slice(0, 10)}` : null,
        group.inUse ? `${group.inUse} in use` : null,
        group.current ? 'current' : group.current === false ? 'older toolchain' : null,
      ].filter(Boolean);
      body.push(
        `    agent-device ${group.packageVersion ?? 'unknown'}, Xcode ${group.xcodeBuildVersion ?? 'unknown'}: ${details.join(', ')}`,
      );
    }
    body.push(chalk.dim(`    remedy: ${runnerBuilds.remedy}`));
  }
  if (!body.length) return [];
  return [
    `Other tools' machine-wide caches${report.complete ? '' : ' (incomplete)'} - measured ${formatLongDuration(Math.max(0, now - Date.parse(report.measuredAt)))} ago`,
    ...body,
    chalk.dim("  Stim reports these and never deletes them; use each tool's own cleanup."),
  ];
}
