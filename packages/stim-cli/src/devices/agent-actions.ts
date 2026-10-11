import { realpath } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  agentDeviceStateDirsAsync,
  createAsyncAgentActionReader as createAsyncSessionActionReader,
  type AgentTarget,
  type MacosAppRecord,
  type NdjsonRecord,
  type ProjectRecord,
} from '@stim-cli/core/state';
import { inspectProcessStart, type ProcessStart } from '../process-identity.ts';
import { projectDeviceSlots } from './device-slots.ts';
import { agentDeviceLiveness, readAgentDeviceRecordsAsync } from './activity.ts';

export type { AgentTarget } from '@stim-cli/core/state';

export function workspaceAgentTargets(
  project: ProjectRecord | null | undefined,
  macos?: MacosAppRecord | null,
): AgentTarget[] {
  const targets: AgentTarget[] = [];
  if (macos?.app && macos.bundleId)
    targets.push({
      platform: 'macos',
      id: macos.launchId,
      slot: 'default',
      bundleId: macos.bundleId,
      launchedAt: macos.app.startedAtMicros / 1000,
    });
  let slots: ReturnType<typeof projectDeviceSlots>;
  try {
    slots = projectDeviceSlots(project);
  } catch {
    return [];
  }
  for (const { slot, platforms } of slots) {
    const { ios, android } = platforms;
    if (ios?.owned && typeof ios.deviceUdid === 'string') targets.push({ platform: 'ios', id: ios.deviceUdid, slot });
    if (android?.owned && typeof android.consolePort === 'number' && typeof android.avdName === 'string')
      targets.push({ platform: 'android', id: `emulator-${android.consolePort}`, slot, name: android.avdName });
  }
  return targets;
}

export interface AgentActionReaderOptions {
  targets: AgentTarget[] | (() => AgentTarget[]);
  sinceTs?: number;
  home?: string;
  now?: () => number;
  startOf?: (pid: number) => ProcessStart;
  env?: NodeJS.ProcessEnv;
}

export function createAsyncAgentActionReader(
  { targets, sinceTs, home = homedir(), env, now, startOf = inspectProcessStart }: AgentActionReaderOptions,
  signal?: AbortSignal,
): () => Promise<NdjsonRecord[]> {
  let sessionsDirs: string[] = [];
  let claimed = new Map<string, string>();
  let canonical = new Map<string, string>();
  const read = createAsyncSessionActionReader(
    {
      sessionsDirs: () => sessionsDirs,
      targets,
      sinceTs,
      now,
      claimedDevice: (session, sessionsDir) =>
        claimed.get(`${canonical.get(dirname(sessionsDir))}\0${session}`) ?? claimed.get(`\0${session}`) ?? null,
    },
    signal,
  );
  return async () => {
    signal?.throwIfAborted();
    const roots = await agentDeviceStateDirsAsync(home, env);
    canonical = new Map();
    const canonicalize = async (path: string) => {
      if (canonical.has(path)) return canonical.get(path)!;
      const value = await realpath(path).catch(() => resolve(path));
      canonical.set(path, value);
      return value;
    };
    for (const root of roots) await canonicalize(root);
    sessionsDirs = roots.map((root) => join(root, 'sessions'));
    claimed = new Map();
    const byId = new Map((typeof targets === 'function' ? targets() : targets).map((target) => [target.id, target]));
    if ([...byId.values()].some((target) => target.platform !== 'macos')) {
      for (const record of await readAgentDeviceRecordsAsync(home, env)) {
        signal?.throwIfAborted();
        if (record.kind !== 'claim' || !record.session || !record.deviceId) continue;
        const target = byId.get(record.deviceId);
        if (!target || target.platform === 'macos' || (target.name !== undefined && target.name !== record.deviceName))
          continue;
        if (agentDeviceLiveness(record, startOf) === 'live')
          claimed.set(
            `${record.stateDir ? await canonicalize(record.stateDir) : ''}\0${record.session}`,
            record.deviceId,
          );
        await nextTurn();
      }
    }
    signal?.throwIfAborted();
    return read();
  };
}
