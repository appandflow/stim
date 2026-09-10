import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ccacheMeasurements, shellCommandSegments } from './run-guards.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export function ccacheLogEvidence({ runDir, meta, commands, worktree, capture = false }) {
  if (meta.arm !== 'stim' || meta.platform !== 'android' || !worktree) return null;
  const builds = commands.filter(
    (entry) =>
      shellCommandSegments(entry.command).some((segment) => /^stim android(?:\s|$)/.test(segment)) &&
      /build\s+compiling/.test(entry.output),
  );
  if (builds.length !== 1) return null;
  const entry = builds[0];
  if (
    [...entry.output.matchAll(/build\s+compiling/g)].length !== 1 ||
    !entry.id ||
    entry.parallelTimingAmbiguous ||
    shellCommandSegments(entry.command).length !== 1 ||
    ![0, 1].includes(entry.exitCode) ||
    !/build\s+ok\b/.test(entry.output) ||
    ccacheMeasurements(entry.output).length
  )
    return null;
  const start = Date.parse(entry.startedAt),
    end = Date.parse(entry.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const statsPath = join(runDir, 'ccache-evidence.log');
  const recordPath = join(runDir, 'ccache-evidence.json');
  try {
    const identity = {
      schemaVersion: 1,
      runId: meta.runId,
      worktree: resolve(worktree),
      commandId: entry.id,
      commandSha256: hash(JSON.stringify(entry)),
      metaSha256: hash(JSON.stringify(meta)),
      eventsSha256: hash(readFileSync(join(runDir, 'events.jsonl'))),
    };
    if (capture && !existsSync(recordPath) && !existsSync(statsPath)) {
      const home = realpathSync(join(runDir, 'stim-home'));
      if (!home.startsWith(`${realpathSync(runDir)}${sep}`)) return null;
      const projects = Object.keys(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).projects ?? {});
      if (projects.length !== 1 || realpathSync(projects[0]) !== realpathSync(worktree)) return null;
      const workspaceHome = join(home, 'workspaces');
      if (!realpathSync(workspaceHome).startsWith(`${home}${sep}`)) return null;
      const logs = readdirSync(workspaceHome)
        .map((name) => join(workspaceHome, name, 'logs', 'ccache-stats.log'))
        .filter((path) => existsSync(path));
      if (
        logs.length !== 1 ||
        !realpathSync(logs[0]).startsWith(`${realpathSync(workspaceHome)}${sep}`) ||
        !lstatSync(logs[0]).isFile()
      )
        return null;
      const before = statSync(logs[0]);
      if (before.mtimeMs < start || before.mtimeMs > end) return null;
      const bytes = readFileSync(logs[0]);
      const after = statSync(logs[0]);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return null;
      writeFileSync(statsPath, bytes, { flag: 'wx' });
      writeFileSync(
        recordPath,
        JSON.stringify({ ...identity, statsSha256: hash(bytes), modifiedAtMs: before.mtimeMs }, null, 2),
        { flag: 'wx' },
      );
    }
    if (!lstatSync(recordPath).isFile() || !lstatSync(statsPath).isFile()) return null;
    const evidence = JSON.parse(readFileSync(recordPath, 'utf8'));
    const bytes = readFileSync(statsPath);
    if (
      Object.entries(identity).some(([key, value]) => evidence[key] !== value) ||
      evidence.statsSha256 !== hash(bytes) ||
      !Number.isFinite(evidence.modifiedAtMs) ||
      evidence.modifiedAtMs < start ||
      evidence.modifiedAtMs > end
    )
      return null;
    const lines = bytes
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim());
    const hits = lines.filter((line) => line === 'direct_cache_hit' || line === 'preprocessed_cache_hit').length;
    const misses = lines.filter((line) => line === 'cache_miss').length;
    if (hits + misses === 0) return null;
    return {
      commandId: entry.id,
      hits,
      misses,
      hitRatePercent: (100 * hits) / (hits + misses),
      source: 'stats-log',
      statsLogSha256: evidence.statsSha256,
    };
  } catch {
    return null;
  }
}
