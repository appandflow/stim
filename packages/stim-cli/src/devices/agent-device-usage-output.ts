import type { AgentDeviceUsage } from '@stim-cli/core/state';
import { formatBytes } from '../fs-util.ts';
import { formatLongDuration } from '../command-output.ts';

const size = (bytes: number | null) => (bytes === null ? 'unknown' : formatBytes(bytes));

export function agentDeviceLines(
  usage: AgentDeviceUsage | null | undefined,
  detailed = false,
  now: number = Date.now(),
): string[] {
  if (!usage || (!usage.stateDir.present && !usage.runnerBuilds.present && !usage.workspaces.length && !usage.hosted))
    return [];
  const lines = [
    `agent-device (${formatBytes(usage.bytes)}${usage.complete ? '' : ', incomplete'}) - measured ${formatLongDuration(Math.max(0, now - Date.parse(usage.measuredAt)))} ago`,
  ];
  lines.push(`  runner builds: ${size(usage.runnerBuilds.bytes)}`);
  for (const platform of usage.runnerBuilds.platforms) {
    lines.push(
      `    ${platform.platform}: ${size(platform.bytes)}, ${platform.entries.length} entries, ${platform.entries.filter((entry) => entry.inUse).length} in use`,
    );
    if (detailed)
      for (const entry of platform.entries) {
        const details = [
          entry.lastUsedAt ? `last use ${entry.lastUsedAt.slice(0, 10)}` : 'last use unknown',
          entry.packageVersion ? `agent-device ${entry.packageVersion}` : null,
          entry.xcodeBuildVersion ? `Xcode ${entry.xcodeBuildVersion}` : null,
          entry.inUse ? `in use (${entry.inUseReason})` : null,
        ].filter(Boolean);
        lines.push(`      ${entry.name}: ${size(entry.bytes)}, ${details.join(', ')}`, `        ${entry.dir}`);
      }
  }
  const { sessions, logs, other } = usage.stateDir;
  lines.push(
    `  sessions: ${size(sessions.bytes)}, ${sessions.count} entries`,
    `  logs: ${size(logs.bytes)}`,
    `  other: ${size(other.bytes)}`,
  );
  if (detailed) for (const entry of other.largest) lines.push(`    ${entry.name}: ${size(entry.bytes)}`);
  const knownWorkspaceBytes = usage.workspaces.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  if (usage.workspaces.length) {
    lines.push(
      `  workspaces: ${usage.workspaces.length}, ${usage.workspaces.some((entry) => entry.bytes === null) ? 'at least ' : ''}${formatBytes(knownWorkspaceBytes)}`,
    );
    if (detailed) for (const entry of usage.workspaces) lines.push(`    ${entry.dir}: ${size(entry.bytes)}`);
  }
  if (usage.hosted)
    lines.push(
      `  stim-server hosted: ${size(usage.hosted.bytes)}${detailed ? `, ${usage.hosted.sessions} entries, ${usage.hosted.dir}` : ''}`,
    );
  if (detailed)
    lines.push(
      '  Stim does not manage this state and never deletes it. A lease flag identifies a live runner; lock and unreadable flags conservatively keep entries in use.',
      "  Clear the rest with agent-device's own tooling or by removing the directories yourself.",
    );
  return lines;
}
