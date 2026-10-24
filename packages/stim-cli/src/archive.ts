import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { withDirLockTransaction, workspaceName, type StimContext } from '@stim-cli/core';
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
  worktreeArchiveRoot,
  archivedUsage,
  archiveEnabled,
  listRecordedDevicesAsync,
  loadConfig,
  readArchivesAsync,
  readBuildHistory,
  endedAgentSessionOf,
  readJsonObject,
  readLastBuilds,
  readPullRequestCache,
  readWorkspaceState,
  recordingEnabled,
  type ArchivedWorkspace,
  type WorkspaceState,
  type WorktreePullRequest,
  type NdjsonRecord,
  countErrorEntries,
  queryLogs,
  sortByTs,
} from '@stim-cli/core/state';
import { machineNumber } from './budget.ts';
import { gitAsync } from './workspace/git.ts';
import { mergeStateAsync } from './workspace/merge-state.ts';
import { childEnvironment } from './workspace/git-read.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
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

function archiveSettings(env: NodeJS.ProcessEnv = process.env) {
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
      const result = machineNumber(`archive.${key}`, config, env);
      if (result.error) throw new Error(result.error);
      return [key, result.value!];
    }),
  );
  return numbers;
}

function enabled(root: string, env: NodeJS.ProcessEnv): boolean {
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
  return archiveEnabled(env, [
    project?.settings,
    common ? config?.repos?.[common]?.settings : undefined,
    present ? readCommittedSettings(root) : undefined,
    config,
  ]);
}

async function files(dir: string, signal?: AbortSignal): Promise<{ path: string; bytes: number; at: number }[]> {
  signal?.throwIfAborted();
  if (!existsSync(dir)) return [];
  const found: { path: string; bytes: number; at: number }[] = [];
  for (const name of await readdir(dir)) {
    signal?.throwIfAborted();
    const path = join(dir, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink ${path}`);
    if (entry.isDirectory()) {
      for (const file of await files(path, signal)) found.push(file);
    } else found.push({ path, bytes: entry.size, at: entry.mtimeMs });
  }
  return found;
}

async function secureTree(dir: string): Promise<void> {
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`refusing symlink ${dir}`);
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink ${path}`);
    if (entry.isDirectory()) await secureTree(path);
    else await chmod(path, 0o600);
  }
}

async function writeRecord(dir: string, record: ArchivedWorkspace): Promise<void> {
  let small = 0;
  for (const name of ['state.json', 'ended-agents.json', 'log-error-index.json']) {
    const path = join(dir, name);
    if (existsSync(path)) small += (await stat(path)).size;
  }
  for (let pass = 0; pass < 8; pass++) {
    record.bytes.total = KINDS.reduce((sum, kind) => sum + record.bytes[kind], record.bytes.record);
    const bytes = small + Buffer.byteLength(`${JSON.stringify(record)}\n`);
    if (bytes === record.bytes.record) break;
    record.bytes.record = bytes;
  }
  record.bytes.total = KINDS.reduce((sum, kind) => sum + record.bytes[kind], record.bytes.record);
  const tmp = join(dir, `.archive-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(tmp, join(dir, 'archive.json'));
  } finally {
    await rm(tmp, { force: true });
  }
  const now = new Date();
  await utimes(archiveRoot(), now, now);
}

async function removeRecord(id: string): Promise<void> {
  const dir = archiveDir(id);
  if (!existsSync(dir)) return;
  const removing = join(archiveRoot(), `.removing-${id}`);
  await rename(dir, removing);
  await rm(removing, { recursive: true, force: true });
}

export interface ArchiveStaging {
  path: string;
  kept: boolean;
  reason: string | null;
  removeCommand: string | null;
}

export async function sweepArchiveStaging(
  remove: boolean,
  waitMs = 0,
  signal?: AbortSignal,
): Promise<ArchiveStaging[]> {
  signal?.throwIfAborted();
  if (!existsSync(archiveRoot())) return [];
  return withDirLockTransaction(
    archiveLock(),
    async () => {
      const entries: ArchiveStaging[] = [];
      for (const name of await readdir(archiveRoot())) {
        signal?.throwIfAborted();
        if (
          !(
            (name.startsWith('.incoming-') &&
              (!name.endsWith('.claims') || !existsSync(join(archiveRoot(), name.slice(0, -'.claims'.length))))) ||
            name.startsWith('.removing-')
          )
        )
          continue;
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
            signal?.throwIfAborted();
            await rm(path, { recursive: true, force: true });
            continue;
          }
        }
        entries.push(entry);
      }
      return entries;
    },
    { waitMs, signal },
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

async function gitFacts(root: string, operation?: StimContext): Promise<ArchivedWorkspace['worktree']> {
  const empty: ArchivedWorkspace['worktree'] = {
    repository: null,
    branch: null,
    head: null,
    subject: null,
    merged: null,
    pullRequest: null,
  };
  if (!existsSync(root)) return cachedFacts(root) ?? empty;
  const execution = {
    ...childEnvironment(operation?.env ?? process.env),
    signal: operation?.signal,
    declareFor: operation,
    cwd: operation?.cwd,
    killSignal: 'SIGKILL' as const,
  };
  const run = async (args: string[]) => {
    try {
      const result = await gitAsync(root, args, { ...execution, timeoutMs: 1000 });
      operation?.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
      return null;
    }
  };
  const common = gitCommonDirOnDisk(root);
  const summary = (await run(['show', '-s', '--format=%H%n%s', 'HEAD']))?.split('\n');
  const location = (await run(['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']))?.split('\n');
  const branch = location?.[1] && location[1] !== 'HEAD' ? location[1] : null;
  const defaultRef = await run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  let merged: boolean | null = null;
  if (defaultRef?.startsWith('refs/remotes/')) {
    const state = await mergeStateAsync(
      root,
      { ref: defaultRef, name: defaultRef.slice('refs/remotes/'.length) },
      { ...execution, timeoutMs: 2000 },
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
    pullRequest: archivedPullRequest(pr),
  };
}

function archivedPullRequest(pr: WorktreePullRequest | null | undefined): ArchivedWorkspace['worktree']['pullRequest'] {
  return pr ? { number: pr.number, state: pr.state, title: pr.title, url: pr.url } : null;
}

function cachedFacts(root: string): ArchivedWorkspace['worktree'] | null {
  for (let path = root; !existsSync(path); path = dirname(path)) {
    const cached = readPullRequestCache(path);
    if (!cached) continue;
    return {
      repository: null,
      branch: cached.branch,
      head: cached.head,
      subject: null,
      merged: cached.pullRequest?.state === 'merged' ? true : null,
      pullRequest: archivedPullRequest(cached.pullRequest),
    };
  }
  return null;
}

function archiveWarning(message: string, operation?: StimContext): void {
  if (operation) operation.output('stderr', `${message}\n`);
  else console.error(message);
}

/** Publishes history once its first move starts; cancellation then skips retention and further cleanup. */
export async function archiveWorkspace(
  root: string,
  removedBy: 'worktree-remove' | 'gc' | 'maintenance',
  state: WorkspaceState | null = readWorkspaceState(root),
  operation?: StimContext,
): Promise<void> {
  operation?.signal.throwIfAborted();
  await writeArchive(root, removedBy, state, operation);
  operation?.signal.throwIfAborted();
  try {
    await enforceArchiveRetention(undefined, operation);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError) throw error;
    operation?.signal.throwIfAborted();
    archiveWarning(
      `could not enforce archive retention: ${String((error as Error)?.message ?? error).split('\n')[0]}`,
      operation,
    );
  }
}

async function writeArchive(
  root: string,
  removedBy: 'worktree-remove' | 'gc' | 'maintenance',
  state: WorkspaceState | null,
  operation?: StimContext,
): Promise<void> {
  const env = operation?.env ?? process.env;
  let staging: string | null = null;
  let claim: ReturnType<typeof tryAcquireClaim>['acquired'];
  try {
    const dir = workspaceDir(root);
    if (!existsSync(dir) || (await lstat(dir)).isSymbolicLink()) return;
    if (existsSync(root)) root = realpathSync(root);
    try {
      await sweepArchiveStaging(true, 5000, operation?.signal);
    } catch {
      operation?.signal.throwIfAborted();
    }
    if (!enabled(root, env)) return;
    const limits = archiveSettings(env);
    if (!limits.maxAgeDays || !limits.maxCount) return;
    const logs = join(dir, 'logs');
    if (
      !existsSync(join(dir, 'state.json')) &&
      !Object.values(readBuildHistory(state)).some((entries) => entries?.length) &&
      (!existsSync(logs) || (await readdir(logs)).length === 0)
    )
      return;
    const worktree = await gitFacts(root, operation);
    operation?.signal.throwIfAborted();
    await mkdir(archiveRoot(), { recursive: true, mode: 0o700 });
    await chmod(archiveRoot(), 0o700);
    const token = randomUUID();
    staging = join(archiveRoot(), `.incoming-${token}`);
    const attempt = tryAcquireClaim({ root: `${staging}.claims`, mode: 'exclusive', label: 'archive staging' });
    claim = attempt.acquired;
    if (!claim) {
      releaseClaim(attempt.pending);
      throw new Error('archive staging claim is held');
    }
    await withDirLockTransaction(
      archiveLock(),
      async () => {
        operation?.signal.throwIfAborted();
        let movedHistory = false;
        const moveHistory = async (from: string, to: string) => {
          if (!movedHistory) operation?.signal.throwIfAborted();
          await rename(from, to);
          movedHistory = true;
        };
        await mkdir(staging!, { mode: 0o700 });
        let at = Date.now();
        const workspace = workspaceName(root);
        while (existsSync(archiveDir(`${workspace}--${at}`))) at++;
        const id = `${workspace}--${at}`;
        if (state) {
          const { supervisor: _supervisor, collectors: _collectors, warm: _warm, ...stable } = state;
          await writeFile(join(staging!, 'state.json'), `${JSON.stringify(stripPids(stable))}\n`, { mode: 0o600 });
        }
        for (const name of ['ended-agents.json', 'log-error-index.json']) {
          const data = readJsonObject(join(dir, name));
          if (data) await writeFile(join(staging!, name), `${JSON.stringify(stripPids(data))}\n`, { mode: 0o600 });
        }
        const move = async (kind: Kind) => {
          const from = join(dir, KIND_PATH[kind]);
          if (!limits[`${kind}.maxAgeDays`] || !existsSync(from)) return;
          const to = join(staging!, KIND_PATH[kind]);
          await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
          await moveHistory(from, to);
          await secureTree(to);
        };
        await move('logs');
        await move('agentActions');
        const config = loadConfig();
        if (
          limits['recordings.maxAgeDays'] &&
          workspaceRecordingEnabled(root, config?.projects?.[root] ?? {}, config, env)
        ) {
          const recordingDir = join(dir, 'recordings');
          if (existsSync(recordingDir) && (await lstat(recordingDir)).isSymbolicLink())
            throw new Error(`refusing symlink ${recordingDir}`);
          for (const device of await listRecordedDevicesAsync(
            recordingDir,
            false,
            movedHistory ? undefined : operation?.signal,
          )) {
            if ((await lstat(device.dir)).isSymbolicLink()) throw new Error(`refusing symlink ${device.dir}`);
            const to = join(staging!, 'recordings', `${device.platform}-${device.slot}`);
            for (const segment of device.segments.filter((entry) => !entry.open)) {
              await mkdir(to, { recursive: true, mode: 0o700 });
              try {
                if ((await lstat(segment.file)).isSymbolicLink()) throw new Error(`refusing symlink ${segment.file}`);
                await moveHistory(segment.file, join(to, basename(segment.file)));
                await chmod(join(to, basename(segment.file)), 0o600);
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
          bytes[kind] = (await files(join(staging!, KIND_PATH[kind]))).reduce((sum, file) => sum + file.bytes, 0);
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
        if (!movedHistory) operation?.signal.throwIfAborted();
        await writeRecord(staging!, record);
        await rename(staging!, archiveDir(id));
      },
      { waitMs: 30_000, signal: operation?.signal },
    );
    releaseClaim(claim);
    claim = undefined;
    staging = null;
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError) throw error;
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true });
      } catch {}
    }
    operation?.signal.throwIfAborted();
    archiveWarning(`could not archive: ${String((error as Error)?.message ?? error).split('\n')[0]}`, operation);
  } finally {
    releaseClaim(claim);
  }
}

async function removeKind(record: ArchivedWorkspace, kind: Kind): Promise<void> {
  await rm(join(archiveDir(record.id), KIND_PATH[kind]), { recursive: true, force: true });
  record.bytes[kind] = 0;
  record.expires[kind] = null;
  await writeRecord(archiveDir(record.id), record);
}

function logRemovalOrder(path: string): number {
  return /\.ndjson\.\d+$/.test(path) ? 0 : /^build-.*\.ndjson$/.test(basename(path)) ? 1 : 2;
}

/**
 * How long and how large worktree archives of `root` are kept, from `archive.maxAgeDays` and `archive.maxTotalGb`, or
 * why its uncommitted changes cannot be archived: archives are disabled for it, a limit is 0, or a setting is invalid.
 */
export function worktreeArchiveLimits(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): { maxAgeDays: number; maxBytes: number } | { refusal: string } {
  if (!enabled(root, env)) return { refusal: 'archive.enabled is false for it' };
  let limits: Record<string, number>;
  try {
    limits = archiveSettings(env);
  } catch (error) {
    return { refusal: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '' };
  }
  if (!limits.maxAgeDays) return { refusal: 'archive.maxAgeDays is 0, so no archive would be kept' };
  if (!limits.maxTotalGb) return { refusal: 'archive.maxTotalGb is 0, so no archive would be kept' };
  return { maxAgeDays: limits.maxAgeDays, maxBytes: limits.maxTotalGb * 1024 ** 3 };
}

async function listWorktreeArchives(
  signal?: AbortSignal,
): Promise<{ repositories: string[]; entries: { path: string; at: number; bytes: number }[] }> {
  const root = worktreeArchiveRoot();
  let repositories: string[];
  try {
    repositories = await readdir(root);
  } catch {
    return { repositories: [], entries: [] };
  }
  const entries: { path: string; at: number; bytes: number }[] = [];
  for (const repository of repositories) {
    signal?.throwIfAborted();
    const dir = join(root, repository);
    if (!(await lstat(dir)).isDirectory()) continue;
    for (const name of await readdir(dir)) {
      if (name.endsWith('.claims')) continue;
      const path = join(dir, name);
      const entry = await lstat(path);
      if (!entry.isDirectory()) continue;
      const created = Date.parse(String(readJsonObject(join(path, 'manifest.json'))?.createdAt ?? ''));
      const bytes = (await files(path, signal)).reduce((sum, file) => sum + file.bytes, 0);
      entries.push({ path, at: Number.isFinite(created) ? created : entry.mtimeMs, bytes });
    }
  }
  return { repositories, entries };
}

/** Bytes every worktree archive holds, the one being written included. */
export async function worktreeArchiveBytes(signal?: AbortSignal): Promise<number> {
  return (await listWorktreeArchives(signal)).entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

async function pruneWorktreeArchives(now: number, limits: Record<string, number>, signal?: AbortSignal): Promise<void> {
  const { repositories, entries } = await listWorktreeArchives(signal);
  entries.sort((a, b) => a.at - b.at);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const cap = (limits.maxTotalGb ?? 0) * 1024 ** 3;
  const maxAgeMs = (limits.maxAgeDays ?? 0) * DAY;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (now - entry.at < maxAgeMs && total <= cap) continue;
    if (clearFreeClaimSet({ root: `${entry.path}.claims`, label: 'worktree archive' }).status !== 'cleared') continue;
    await rm(entry.path, { recursive: true, force: true });
    total -= entry.bytes;
  }
  for (const repository of repositories) {
    try {
      await rmdir(join(worktreeArchiveRoot(), repository));
    } catch {}
  }
}

export async function enforceArchiveRetention(now: number = Date.now(), operation?: StimContext): Promise<void> {
  const signal = operation?.signal;
  const env = operation?.env ?? process.env;
  signal?.throwIfAborted();
  if (!existsSync(archiveRoot())) return;
  let limits: Record<string, number>;
  try {
    limits = archiveSettings(env);
  } catch (error) {
    archiveWarning(
      `could not enforce archive retention: ${String((error as Error).message).split('\n')[0]}`,
      operation,
    );
    return;
  }
  await withDirLockTransaction(
    archiveLock(),
    async () => {
      const listed = (await readArchivesAsync(signal)).toReversed();
      const records = listed.filter(
        (record, index) =>
          limits.maxAgeDays! > 0 &&
          now - Date.parse(record.removedAt) < limits.maxAgeDays! * DAY &&
          index >= listed.length - limits.maxCount!,
      );
      for (const record of listed) {
        signal?.throwIfAborted();
        if (!records.includes(record)) await removeRecord(record.id);
      }
      const recordings = recordingEnabled(env, [loadConfig()]);
      for (const record of records) {
        signal?.throwIfAborted();
        for (const kind of ['recordings', 'agentActions', 'logs'] as const) {
          signal?.throwIfAborted();
          const age = limits[`${kind}.maxAgeDays`]!;
          if (
            record.bytes[kind] &&
            (!age || now - Date.parse(record.removedAt) >= age * DAY || (kind === 'recordings' && !recordings))
          )
            await removeKind(record, kind);
        }
        const cap = limits['logs.maxMbPerWorkspace']! * 1024 ** 2;
        if (record.bytes.logs > cap) {
          const entries = (await files(join(archiveDir(record.id), 'logs'), signal)).toSorted(
            (a, b) =>
              logRemovalOrder(a.path) - logRemovalOrder(b.path) ||
              (logRemovalOrder(a.path) === 0
                ? Number(b.path.split('.').at(-1)) - Number(a.path.split('.').at(-1))
                : 0) ||
              a.at - b.at,
          );
          let removed = false;
          try {
            for (const file of entries) {
              signal?.throwIfAborted();
              if (record.bytes.logs <= cap) break;
              await rm(file.path);
              record.bytes.logs = Math.max(0, record.bytes.logs - file.bytes);
              removed = true;
            }
          } finally {
            if (removed) {
              if (!record.bytes.logs) record.expires.logs = null;
              await writeRecord(archiveDir(record.id), record);
            }
          }
        }
      }
      const totalCap = limits.maxTotalGb! * 1024 ** 3;
      const recordingCap = limits['recordings.maxTotalGb']! * 1024 ** 3;
      for (const record of records) {
        signal?.throwIfAborted();
        for (;;) {
          signal?.throwIfAborted();
          const usage = archivedUsage(records);
          const totalOver = usage.bytes > totalCap;
          const recordingsOver = usage.byKind.recordings > recordingCap;
          if (!totalOver && !recordingsOver) break;
          const candidates = KINDS.filter(
            (kind) => record.bytes[kind] > 0 && (totalOver || kind === 'recordings'),
          ).toSorted((a, b) => record.bytes[b] - record.bytes[a]);
          if (!candidates.length) break;
          await removeKind(record, candidates[0]!);
        }
      }
      for (const record of records) {
        signal?.throwIfAborted();
        const before = JSON.stringify(record.expires);
        for (const kind of KINDS)
          record.expires[kind] = record.bytes[kind]
            ? new Date(Date.parse(record.removedAt) + limits[`${kind}.maxAgeDays`]! * DAY).toISOString()
            : null;
        record.expires.record = new Date(Date.parse(record.removedAt) + limits.maxAgeDays! * DAY).toISOString();
        if (JSON.stringify(record.expires) !== before) await writeRecord(archiveDir(record.id), record);
      }
      await pruneWorktreeArchives(now, limits, signal);
    },
    { waitMs: 30_000, signal },
  );
}

export async function deleteSelectedArchives(
  ids: readonly string[],
  kind: Kind | null,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await withDirLockTransaction(
    archiveLock(),
    async () => {
      for (const record of (await readArchivesAsync(signal)).filter((entry) => ids.includes(entry.id))) {
        signal?.throwIfAborted();
        if (kind) await removeKind(record, kind);
        else await removeRecord(record.id);
      }
    },
    { waitMs: 30_000, signal },
  );
}
