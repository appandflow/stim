import { configDir, type StimContext } from '@stim-cli/core';
import { archiveRoot, type MaintenanceAction } from '@stim-cli/core/state';
import { listMountedVolumes } from '../../fs-util.ts';
import { loadConfig } from '../../workspace/config.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { plural } from '../../command-output.ts';
import { deleteProjectDevices, deviceSweepIsScoped } from '../../commands/gc/devices.ts';
import { forgetStaleLedgerEntries } from '../../commands/gc/ledger.ts';
import { forgetStaleEasLedgerEntries } from '../../commands/gc/eas-ledger.ts';
import { forgetGoneHomes } from '../../commands/gc/other-homes.ts';
import { collectWorkspaceLogs, trimWorkspaceLogs } from '../../commands/gc/logs.ts';
import { collectRecordings, deleteRecordings } from '../../commands/gc/recordings.ts';
import { collectParkedHostedDevices, deleteParkedHostedDevices } from '../../commands/gc/hosted-devices.ts';
import { deleteEasSessions } from '../../commands/gc/eas-sessions.ts';
import { collectArchives, deleteArchives, type ArchiveKind } from '../../commands/gc/archives.ts';
import { collectOrphanedWorkspaces } from '../../commands/gc/workspaces.ts';
import {
  clearStaleClaims,
  collectDeviceRecords,
  collectProjectEasSessions,
  collectProjectRecords,
  collectStaleClaims,
  findStaleEasLedgerEntries,
  pruneDeadProjects,
  removeInvalidProjectEntries,
  type DeviceRecords,
} from '../../commands/gc/records.ts';
import { GC_OUTPUT, type GcResult } from '../../commands/gc/results.ts';
import type { MaintenancePlan } from './plan.ts';

const ORPHANED_DEVICES = 'owned devices of removed projects';
const ARCHIVE_KINDS: readonly ArchiveKind[] = ['logs', 'recordings', 'agentActions'];

const isCleanupError = (error: unknown) =>
  error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error);

async function goneWorkspaceDirs(dead: readonly string[], operation?: StimContext): Promise<string[]> {
  const { orphaned } = await collectOrphanedWorkspaces(Object.keys(loadConfig()?.projects ?? {}), listMountedVolumes(), {
    measure: false,
    operation,
  });
  return [...orphaned.map((entry) => entry.dir), ...dead.map(workspaceDir)];
}

function staleRecordCount(devices: DeviceRecords | null): number {
  return (
    (devices?.staleLedgerEntries.length ?? 0) +
    findStaleEasLedgerEntries(listMountedVolumes()).length +
    (devices?.otherHomes?.homes.filter((home) => home.forgettable).length ?? 0) +
    collectStaleClaims().buildLocks.stale.length +
    collectStaleClaims().buildSlots.stale.length
  );
}

/**
 * The records that outlived what they describe and the leftovers of removed projects, by the rules `stim gc` applies:
 * registry entries whose project is gone or unreadable, the owned devices and device records of removed projects,
 * stale ledger entries, gone Stim homes and build claims whose holder is gone, workspace logs over their cap, parked
 * hosted devices and, outside the daemon, the orphaned EAS sessions of the current Expo project.
 */
export async function planRecords({
  devices = true,
  background = false,
  operation,
}: {
  devices?: boolean;
  background?: boolean;
  operation?: StimContext;
}): Promise<MaintenancePlan> {
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const blocked: string[] = [];
  const attempt = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      if (isCleanupError(error)) throw error;
      operation?.signal.throwIfAborted();
      blocked.push(`Could not look for ${what}: ${error instanceof Error ? error.message : error}`);
    }
  };
  const cfg = loadConfig();
  const { deadProjects, invalidProjects, skipped } = collectProjectRecords(cfg);
  for (const path of deadProjects)
    actions.push({ kind: 'would-prune-project', target: path, bytes: 0, reason: 'its project folder no longer exists' });
  for (const path of invalidProjects)
    actions.push({ kind: 'would-prune-project', target: path, bytes: 0, reason: 'its registry entry is invalid' });
  for (const entry of skipped) skips.push({ target: entry.dir, reason: entry.reason });

  let deviceRecords: DeviceRecords | null = null;
  if (devices)
    await attempt('owned devices of removed projects', async () => {
      deviceRecords = await collectDeviceRecords(cfg, deadProjects, { operation });
      const records = deviceRecords;
      const count = records.orphanedDevices.length + records.staleDeviceRecords.length;
      if (count)
        actions.push({
          kind: 'would-delete-orphaned-devices',
          target: ORPHANED_DEVICES,
          bytes: records.orphanedDevices.reduce((sum, device) => sum + (device.bytes ?? 0), 0),
          reason: `${plural(count, 'owned device or device record', 'owned devices or device records')} whose project is gone`,
        });
      for (const notice of records.notices) skips.push({ target: 'devices', reason: notice });
    });

  await attempt('stale records', async () => {
    const count = staleRecordCount(deviceRecords);
    if (count)
      actions.push({
        kind: 'would-forget-stale-records',
        target: configDir(),
        bytes: 0,
        reason: `${plural(count, 'ledger entry, gone Stim home or build claim', 'ledger entries, gone Stim homes or build claims')} whose device, home or holder is gone`,
      });
  });

  await attempt('workspace logs over their cap', async () => {
    const gone = await goneWorkspaceDirs(deadProjects, operation);
    for (const entry of await collectWorkspaceLogs({ exclude: gone, operation })) {
      if (entry.willTrim && entry.projectRoot)
        actions.push({
          kind: 'would-trim-workspace-logs',
          target: entry.dir,
          workspace: entry.projectRoot,
          bytes: entry.trimBytes,
          reason: 'each log keeps its newest 8 MiB',
        });
      else if (entry.keptReason && entry.trimBytes > 0) skips.push({ target: entry.dir, reason: entry.keptReason });
    }
  });

  if (devices)
    await attempt('parked hosted devices', async () => {
      const hosted = collectParkedHostedDevices();
      const listed = hosted.devices.filter((device) => device.listed !== false);
      if (listed.length)
        actions.push({
          kind: 'would-delete-hosted-devices',
          target: 'parked hosted devices',
          bytes: 0,
          reason: `${plural(listed.length, 'device')} parked by hosted sessions`,
        });
      for (const notice of hosted.notices) skips.push({ target: 'hosted devices', reason: notice });
    });

  if (!background)
    await attempt('orphaned EAS sessions', async () => {
      const sweep = await collectProjectEasSessions({ operation });
      if (!sweep) return;
      if (sweep.orphaned.length && sweep.projectScope)
        actions.push({
          kind: 'would-delete-eas-sessions',
          target: sweep.projectScope,
          bytes: 0,
          reason: `${plural(sweep.orphaned.length, 'EAS session')} no workspace holds`,
        });
      for (const notice of sweep.notices) skips.push({ target: 'EAS sessions', reason: notice });
    });

  return { actions, blocked, skips };
}

/** At critical: every device recording, and the logs, recordings and agent actions of every archive. */
export async function planHistory(operation?: StimContext): Promise<MaintenanceAction[]> {
  const actions: MaintenanceAction[] = [];
  const recordings = await collectRecordings(
    { whole: false, olderThan: 0, now: Date.now() },
    [],
    operation?.signal,
  );
  const bytes = recordings.filter((entry) => entry.willDelete).reduce((sum, entry) => sum + entry.deleteBytes, 0);
  if (bytes > 0)
    actions.push({
      kind: 'would-delete-recordings',
      target: 'device recordings',
      bytes,
      reason: 'every recorded segment that is not being written',
    });
  for (const kind of ARCHIVE_KINDS) {
    const selection = await collectArchives({ kind, id: null }, operation?.signal);
    const records = selection.records.filter((record) => record.willDelete);
    if (records.length)
      actions.push({
        kind: 'would-delete-archives',
        target: kind,
        dir: archiveRoot(),
        bytes: records.reduce((sum, record) => sum + record.bytes, 0),
        reason: `the archived ${kind === 'agentActions' ? 'agent actions' : kind} of ${plural(records.length, 'removed workspace')}`,
      });
  }
  return actions;
}

/** Carries out a records action, collecting again first so only what is still stale goes. */
export async function executeRecordAction(
  action: MaintenanceAction,
  operation: StimContext | undefined,
  quietly: <T>(run: () => Promise<T> | T) => Promise<{ value: T; results: GcResult[] }>,
): Promise<{ failures: number; results: GcResult[] }> {
  const signal = operation?.signal;
  const run = async (work: () => Promise<number>) => {
    const { value, results } = await quietly(work);
    return { failures: value, results };
  };
  switch (action.kind) {
    case 'would-prune-project':
      return run(async () => {
        const { deadProjects, invalidProjects } = collectProjectRecords();
        if (invalidProjects.includes(action.target)) {
          await removeInvalidProjectEntries([action.target], GC_OUTPUT, signal);
          return 0;
        }
        return deadProjects.includes(action.target) ? pruneDeadProjects([action.target], GC_OUTPUT, operation) : 0;
      });
    case 'would-delete-orphaned-devices':
      return run(async () => {
        if (deviceSweepIsScoped(operation?.env ?? process.env)) return 0;
        const records = await collectDeviceRecords(loadConfig(), collectProjectRecords().deadProjects, { operation });
        return deleteProjectDevices(records.orphanedDevices, [], records.staleDeviceRecords, GC_OUTPUT, operation);
      });
    case 'would-forget-stale-records':
      return run(async () => {
        const mounted = listMountedVolumes();
        const records = deviceSweepIsScoped(operation?.env ?? process.env)
          ? null
          : await collectDeviceRecords(loadConfig(), collectProjectRecords().deadProjects, { operation });
        let failures = await forgetStaleLedgerEntries(records?.staleLedgerEntries ?? [], GC_OUTPUT, signal);
        failures += await forgetStaleEasLedgerEntries(findStaleEasLedgerEntries(mounted), mounted, {}, GC_OUTPUT, signal);
        failures += forgetGoneHomes(records?.otherHomes?.homes ?? [], mounted, {}, GC_OUTPUT);
        failures += clearStaleClaims(collectStaleClaims(), GC_OUTPUT, signal);
        return failures;
      });
    case 'would-trim-workspace-logs':
      return run(async () => {
        const entries = (await collectWorkspaceLogs({ operation })).filter((entry) => entry.dir === action.target);
        return trimWorkspaceLogs(entries, GC_OUTPUT, operation);
      });
    case 'would-delete-hosted-devices':
      return run(() => deleteParkedHostedDevices(collectParkedHostedDevices().devices, { operation }, GC_OUTPUT));
    case 'would-delete-eas-sessions':
      return run(async () => {
        const sweep = await collectProjectEasSessions({ operation });
        return sweep && sweep.projectScope === action.target ? deleteEasSessions(sweep, { operation }, GC_OUTPUT) : 0;
      });
    case 'would-delete-recordings':
      return run(async () => {
        const plan = { whole: false, olderThan: 0, now: Date.now() };
        return deleteRecordings(await collectRecordings(plan, [], signal), plan, GC_OUTPUT, signal);
      });
    case 'would-delete-archives':
      return run(async () =>
        deleteArchives(await collectArchives({ kind: action.target as ArchiveKind, id: null }, signal), GC_OUTPUT, signal),
      );
    default:
      return { failures: 0, results: [] };
  }
}
