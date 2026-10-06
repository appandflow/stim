import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withDirLock, workspaceName } from '@stim-cli/core';
import {
  claimRemoveCommand,
  clearFreeClaimSet,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
} from '@stim-cli/core/ownership-claim';
import {
  archiveDir,
  archiveLock,
  archiveRoot,
  archivedUsage,
  archiveEnabled,
  listRecordedDevices,
  loadConfig,
  readArchives,
  readBuildHistory,
  endedAgentSessionOf,
  readJsonObject,
  readLastBuilds,
  readPullRequestCache,
  readWorkspaceState,
  recordingEnabled,
  type ArchivedWorkspace,
  type WorkspaceState,
  type NdjsonRecord,
  countErrorEntries,
  queryLogs,
  sortByTs,
} from '@stim-cli/core/state';
import { machineNumber } from './budget.ts';
import { getExecutor } from './exec.ts';
import { mergeState } from './workspace/merge-state.ts';
import { gitCommonDirOnDisk } from './workspace/worktree.ts';
import { readCommittedSettings } from './workspace/settings.ts';
import { workspaceDir } from './workspace/paths.ts';
import { workspaceRecordingEnabled } from './workspace/recordings.ts';

const DAY = 86_400_000;
const KINDS = ['logs', 'recordings', 'agentActions'] as const;
type Kind = (typeof KINDS)[number];
const KIND_PATH: Record<Kind, string> = {
  logs: 'logs',
  recordings: 'recordings',
  agentActions: 'agent-device/sessions',
};

function archiveSettings() {
  const config = loadConfig();
  const numbers = Object.fromEntries(
    [
      'maxAgeDays',
      'maxCount',
      'maxTotalGb',
      'logs.maxAgeDays',
      'logs.maxMbPerWorkspace',
      'recordings.maxAgeDays',
      'recordings.maxTotalGb',
      'agentActions.maxAgeDays',
    ].map((key) => {
      const result = machineNumber(`archive.${key}`, config, process.env);
      if (result.error) throw new Error(result.error);
      return [key, result.value!];
    }),
  );
  return numbers;
}

function enabled(root: string): boolean {
  const config = loadConfig();
  const project = config?.projects?.[root];
  const present = existsSync(root);
  const common = present ? gitCommonDirOnDisk(root) : null;
  if (
    !present &&
    Object.values(config?.repos ?? {}).some(
      (repo) => (repo.settings as { archive?: { enabled?: unknown } })?.archive?.enabled === false,
    )
  )
    return false;
  return archiveEnabled(process.env, [
    project?.settings,
    common ? config?.repos?.[common]?.settings : undefined,
    present ? readCommittedSettings(root) : undefined,
    config,
  ]);
}

function files(dir: string): { path: string; bytes: number; at: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink ${path}`);
    return stat.isDirectory() ? files(path) : [{ path, bytes: stat.size, at: stat.mtimeMs }];
  });
}

function secureTree(dir: string): void {
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`refusing symlink ${dir}`);
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink ${path}`);
    if (stat.isDirectory()) secureTree(path);
    else chmodSync(path, 0o600);
  }
}

function writeRecord(dir: string, record: ArchivedWorkspace): void {
  const small = ['state.json', 'ended-agents.json', 'log-error-index.json'].reduce((sum, name) => {
    const path = join(dir, name);
    return sum + (existsSync(path) ? statSync(path).size : 0);
  }, 0);
  for (let pass = 0; pass < 8; pass++) {
    record.bytes.total = KINDS.reduce((sum, kind) => sum + record.bytes[kind], record.bytes.record);
    const bytes = small + Buffer.byteLength(`${JSON.stringify(record)}\n`);
    if (bytes === record.bytes.record) break;
    record.bytes.record = bytes;
  }
  record.bytes.total = KINDS.reduce((sum, kind) => sum + record.bytes[kind], record.bytes.record);
  const tmp = join(dir, `.archive-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, join(dir, 'archive.json'));
  } finally {
    rmSync(tmp, { force: true });
  }
  const now = new Date();
  utimesSync(archiveRoot(), now, now);
}

function removeRecord(id: string): void {
  const dir = archiveDir(id);
  if (!existsSync(dir)) return;
  const removing = join(archiveRoot(), `.removing-${id}`);
  renameSync(dir, removing);
  rmSync(removing, { recursive: true, force: true });
}

export interface ArchiveStaging {
  path: string;
  kept: boolean;
  reason: string | null;
  removeCommand: string | null;
}

export function sweepArchiveStaging(remove: boolean, waitMs = 0): ArchiveStaging[] {
  if (!existsSync(archiveRoot())) return [];
  return withDirLock(
    archiveLock(),
    () =>
      readdirSync(archiveRoot())
        .filter(
          (name) =>
            (name.startsWith('.incoming-') &&
              (!name.endsWith('.claims') || !existsSync(join(archiveRoot(), name.slice(0, -'.claims'.length))))) ||
            name.startsWith('.removing-'),
        )
        .flatMap((name) => {
          const path = join(archiveRoot(), name.endsWith('.claims') ? name.slice(0, -'.claims'.length) : name);
          const root = `${path}.claims`;
          const survey = name.startsWith('.incoming-') ? readClaimSet(root) : null;
          const unresolved = survey?.unresolved[0];
          const kept = Boolean(survey && (survey.live.length || survey.unresolved.length));
          const entry: ArchiveStaging = {
            path,
            kept,
            reason: unresolved?.reason ?? (kept ? 'live archive writer' : null),
            removeCommand: unresolved ? claimRemoveCommand(root) : null,
          };
          if (remove && !kept) {
            if (!survey || clearFreeClaimSet({ root, label: 'archive staging' }).status === 'cleared') {
              rmSync(path, { recursive: true, force: true });
              return [];
            }
          }
          return [entry];
        }),
    { waitMs },
  );
}

function stripPids(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPids);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/pids?$/i.test(key))
        .map(([key, child]) => [key, stripPids(child)]),
    );
  return value;
}

function gitFacts(root: string): ArchivedWorkspace['worktree'] {
  const empty: ArchivedWorkspace['worktree'] = {
    repository: null,
    branch: null,
    head: null,
    subject: null,
    merged: null,
    pullRequest: null,
  };
  if (!existsSync(root)) return empty;
  const exec = getExecutor();
  const run = (args: string[]) => exec.runFileQuiet('git', ['-C', root, ...args], { timeoutMs: 1000 });
  const common = gitCommonDirOnDisk(root);
  const summary = run(['show', '-s', '--format=%H%n%s', 'HEAD'])?.split('\n');
  const location = run(['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])?.split('\n');
  const branch = location?.[1] && location[1] !== 'HEAD' ? location[1] : null;
  const defaultRef = run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  let merged: boolean | null = null;
  if (defaultRef?.startsWith('refs/remotes/')) {
    const state = mergeState(
      root,
      { ref: defaultRef, name: defaultRef.slice('refs/remotes/'.length) },
      { timeoutMs: 2000 },
    );
    merged = state.merged ? true : state.unknown ? null : false;
  }
  let prPath = root;
  try {
    if (location?.[0]) prPath = realpathSync(location[0]);
  } catch {}
  const pr = readPullRequestCache(prPath)?.pullRequest;
  if (pr?.state === 'merged') merged = true;
  return {
    repository: common ? (basename(common) === '.git' ? dirname(common) : common) : null,
    branch,
    head: summary?.[0] ?? null,
    subject: summary?.[1] ?? null,
    merged,
    pullRequest: pr ? { number: pr.number, state: pr.state, title: pr.title, url: pr.url } : null,
  };
}

export function archiveWorkspace(
  root: string,
  removedBy: 'worktree-remove' | 'gc' | 'maintenance',
  state: WorkspaceState | null = readWorkspaceState(root),
): void {
  writeArchive(root, removedBy, state);
  try {
    enforceArchiveRetention();
  } catch (error) {
    console.error(`could not enforce archive retention: ${String((error as Error)?.message ?? error).split('\n')[0]}`);
  }
}

function writeArchive(
  root: string,
  removedBy: 'worktree-remove' | 'gc' | 'maintenance',
  state: WorkspaceState | null,
): void {
  let staging: string | null = null;
  let claim: ReturnType<typeof tryAcquireClaim>['acquired'];
  try {
    const dir = workspaceDir(root);
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return;
    if (existsSync(root)) root = realpathSync(root);
    try {
      sweepArchiveStaging(true, 5000);
    } catch {}
    if (!enabled(root)) return;
    const limits = archiveSettings();
    if (!limits.maxAgeDays || !limits.maxCount) return;
    const logs = join(dir, 'logs');
    if (
      !existsSync(join(dir, 'state.json')) &&
      !Object.values(readBuildHistory(state)).some((entries) => entries?.length) &&
      (!existsSync(logs) || readdirSync(logs).length === 0)
    )
      return;
    const worktree = gitFacts(root);
    mkdirSync(archiveRoot(), { recursive: true, mode: 0o700 });
    chmodSync(archiveRoot(), 0o700);
    const token = randomUUID();
    staging = join(archiveRoot(), `.incoming-${token}`);
    const attempt = tryAcquireClaim({ root: `${staging}.claims`, mode: 'exclusive', label: 'archive staging' });
    claim = attempt.acquired;
    if (!claim) {
      releaseClaim(attempt.pending);
      throw new Error('archive staging claim is held');
    }
    withDirLock(
      archiveLock(),
      () => {
        mkdirSync(staging!, { mode: 0o700 });
        let at = Date.now();
        const workspace = workspaceName(root);
        while (existsSync(archiveDir(`${workspace}--${at}`))) at++;
        const id = `${workspace}--${at}`;
        if (state) {
          const { supervisor: _supervisor, collectors: _collectors, warm: _warm, ...stable } = state;
          writeFileSync(join(staging!, 'state.json'), `${JSON.stringify(stripPids(stable))}\n`, { mode: 0o600 });
        }
        for (const name of ['ended-agents.json', 'log-error-index.json']) {
          const data = readJsonObject(join(dir, name));
          if (data) writeFileSync(join(staging!, name), `${JSON.stringify(stripPids(data))}\n`, { mode: 0o600 });
        }
        const move = (kind: Kind) => {
          const from = join(dir, KIND_PATH[kind]);
          if (!limits[`${kind}.maxAgeDays`] || !existsSync(from)) return;
          const to = join(staging!, KIND_PATH[kind]);
          mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
          renameSync(from, to);
          secureTree(to);
        };
        move('logs');
        move('agentActions');
        const config = loadConfig();
        if (
          limits['recordings.maxAgeDays'] &&
          workspaceRecordingEnabled(root, config?.projects?.[root] ?? {}, config, process.env)
        ) {
          const recordingDir = join(dir, 'recordings');
          if (existsSync(recordingDir) && lstatSync(recordingDir).isSymbolicLink())
            throw new Error(`refusing symlink ${recordingDir}`);
          for (const device of listRecordedDevices(recordingDir)) {
            if (lstatSync(device.dir).isSymbolicLink()) throw new Error(`refusing symlink ${device.dir}`);
            const to = join(staging!, 'recordings', `${device.platform}-${device.slot}`);
            for (const segment of device.segments.filter((entry) => !entry.open)) {
              mkdirSync(to, { recursive: true, mode: 0o700 });
              try {
                if (lstatSync(segment.file).isSymbolicLink()) throw new Error(`refusing symlink ${segment.file}`);
                renameSync(segment.file, join(to, basename(segment.file)));
                chmodSync(join(to, basename(segment.file)), 0o600);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
          }
        }
        const index = readJsonObject(join(staging!, 'log-error-index.json'));
        const indexed = Object.values(
          (index?.files ?? {}) as Record<string, { markers: Record<string, NdjsonRecord>; errors: NdjsonRecord[] }>,
        ).flatMap((file) => Object.values(file.markers ?? {}).concat(file.errors ?? []));
        const lastErrorCount = countErrorEntries(sortByTs(queryLogs({ records: indexed, errorsOnly: true })));
        const history = Object.values(readBuildHistory(state)).flat();
        const last =
          Object.values(readLastBuilds(state)).toSorted(
            (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
          )[0] ?? null;
        const bytes = { logs: 0, recordings: 0, agentActions: 0, record: 0, total: 0 };
        const expires: ArchivedWorkspace['expires'] = {
          logs: null,
          recordings: null,
          agentActions: null,
          record: new Date(at + limits.maxAgeDays! * DAY).toISOString(),
        };
        for (const kind of KINDS) {
          bytes[kind] = files(join(staging!, KIND_PATH[kind])).reduce((sum, file) => sum + file.bytes, 0);
          if (bytes[kind]) expires[kind] = new Date(at + limits[`${kind}.maxAgeDays`]! * DAY).toISOString();
        }
        const record: ArchivedWorkspace = {
          id,
          projectRoot: root,
          project: basename(root),
          workspace,
          worktree,
          removedAt: new Date(at).toISOString(),
          removedBy,
          lastUsedAt: typeof state?.lastUsedAt === 'string' ? state.lastUsedAt : null,
          builds: { count: history.length, last, lastErrorCount },
          agents: ((readJsonObject(join(dir, 'ended-agents.json'))?.sessions ?? []) as unknown[])
            .map(endedAgentSessionOf)
            .filter((session) => session !== null),
          bytes,
          expires,
          version: 1,
        };
        writeRecord(staging!, record);
        renameSync(staging!, archiveDir(id));
      },
      { waitMs: 30_000 },
    );
    releaseClaim(claim);
    claim = undefined;
    staging = null;
  } catch (error) {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {}
    }
    console.error(`could not archive: ${String((error as Error)?.message ?? error).split('\n')[0]}`);
  } finally {
    releaseClaim(claim);
  }
}

function removeKind(record: ArchivedWorkspace, kind: Kind): void {
  rmSync(join(archiveDir(record.id), KIND_PATH[kind]), { recursive: true, force: true });
  record.bytes[kind] = 0;
  record.expires[kind] = null;
  writeRecord(archiveDir(record.id), record);
}

function logRemovalOrder(path: string): number {
  return /\.ndjson\.\d+$/.test(path) ? 0 : /^build-.*\.ndjson$/.test(basename(path)) ? 1 : 2;
}

export function enforceArchiveRetention(now: number = Date.now()): void {
  if (!existsSync(archiveRoot())) return;
  let limits: Record<string, number>;
  try {
    limits = archiveSettings();
  } catch (error) {
    console.error(`could not enforce archive retention: ${String((error as Error).message).split('\n')[0]}`);
    return;
  }
  withDirLock(
    archiveLock(),
    () => {
      const listed = readArchives().toReversed();
      const records = listed.filter(
        (record, index) =>
          limits.maxAgeDays! > 0 &&
          now - Date.parse(record.removedAt) < limits.maxAgeDays! * DAY &&
          index >= listed.length - limits.maxCount!,
      );
      for (const record of listed) if (!records.includes(record)) removeRecord(record.id);
      const recordings = recordingEnabled(process.env, [loadConfig()]);
      for (const record of records) {
        for (const kind of ['recordings', 'agentActions', 'logs'] as const) {
          const age = limits[`${kind}.maxAgeDays`]!;
          if (
            record.bytes[kind] &&
            (!age || now - Date.parse(record.removedAt) >= age * DAY || (kind === 'recordings' && !recordings))
          )
            removeKind(record, kind);
        }
        const cap = limits['logs.maxMbPerWorkspace']! * 1024 ** 2;
        if (record.bytes.logs > cap) {
          const entries = files(join(archiveDir(record.id), 'logs')).toSorted(
            (a, b) =>
              logRemovalOrder(a.path) - logRemovalOrder(b.path) ||
              (logRemovalOrder(a.path) === 0
                ? Number(b.path.split('.').at(-1)) - Number(a.path.split('.').at(-1))
                : 0) ||
              a.at - b.at,
          );
          for (const file of entries) {
            if (record.bytes.logs <= cap) break;
            rmSync(file.path);
            record.bytes.logs = Math.max(0, record.bytes.logs - file.bytes);
          }
          if (!record.bytes.logs) record.expires.logs = null;
          writeRecord(archiveDir(record.id), record);
        }
      }
      const totalCap = limits.maxTotalGb! * 1024 ** 3;
      const recordingCap = limits['recordings.maxTotalGb']! * 1024 ** 3;
      for (const record of records) {
        for (;;) {
          const usage = archivedUsage(records);
          const totalOver = usage.bytes > totalCap;
          const recordingsOver = usage.byKind.recordings > recordingCap;
          if (!totalOver && !recordingsOver) break;
          const candidates = KINDS.filter(
            (kind) => record.bytes[kind] > 0 && (totalOver || kind === 'recordings'),
          ).toSorted((a, b) => record.bytes[b] - record.bytes[a]);
          if (!candidates.length) break;
          removeKind(record, candidates[0]!);
        }
      }
      for (const record of records) {
        const before = JSON.stringify(record.expires);
        for (const kind of KINDS)
          record.expires[kind] = record.bytes[kind]
            ? new Date(Date.parse(record.removedAt) + limits[`${kind}.maxAgeDays`]! * DAY).toISOString()
            : null;
        record.expires.record = new Date(Date.parse(record.removedAt) + limits.maxAgeDays! * DAY).toISOString();
        if (JSON.stringify(record.expires) !== before) writeRecord(archiveDir(record.id), record);
      }
    },
    { waitMs: 30_000 },
  );
}

export function deleteSelectedArchives(ids: readonly string[], kind: Kind | null): void {
  withDirLock(
    archiveLock(),
    () => {
      for (const record of readArchives().filter((entry) => ids.includes(entry.id))) {
        if (kind) removeKind(record, kind);
        else removeRecord(record.id);
      }
    },
    { waitMs: 30_000 },
  );
}
