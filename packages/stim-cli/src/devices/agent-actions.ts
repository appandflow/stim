import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  agentDeviceStateDirs,
  createAgentActionReader as createSessionActionReader,
  type AgentTarget,
  type NdjsonRecord,
  type ProjectRecord,
} from '@stim-cli/core/state';
import { inspectProcessStart, type ProcessStart } from '../process-identity.ts';
import { projectDeviceSlots } from './device-slots.ts';
import { agentDeviceLiveness, readAgentDeviceRecords } from './activity.ts';

export type { AgentTarget } from '@stim-cli/core/state';

export function workspaceAgentTargets(project: ProjectRecord | null | undefined): AgentTarget[] {
  const targets: AgentTarget[] = [];
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

function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface AgentActionReaderOptions {
  targets: AgentTarget[];
  sinceTs?: number;
  home?: string;
  now?: () => number;
  startOf?: (pid: number) => ProcessStart;
}

export function createAgentActionReader({
  targets,
  sinceTs,
  home = homedir(),
  now,
  startOf = inspectProcessStart,
}: AgentActionReaderOptions): () => NdjsonRecord[] {
  const byId = new Map(targets.map((target) => [target.id, target]));
  let claimed: Map<string, string> | undefined;
  const read = createSessionActionReader({
    sessionsDirs: () => agentDeviceStateDirs(home).map((root) => join(root, 'sessions')),
    targets,
    sinceTs,
    now,
    claimedDevice: (session, sessionsDir) => {
      claimed ??= new Map(
        readAgentDeviceRecords(home)
          .filter((record) => record.kind === 'claim' && record.session && record.deviceId)
          .filter((record) => {
            const target = byId.get(record.deviceId!);
            return target?.name === undefined || target.name === record.deviceName;
          })
          .filter((record) => agentDeviceLiveness(record, startOf) === 'live')
          .map((record) => [
            `${record.stateDir ? canonicalDir(record.stateDir) : ''}\0${record.session}`,
            record.deviceId!,
          ]),
      );
      return claimed.get(`${canonicalDir(dirname(sessionsDir))}\0${session}`) ?? claimed.get(`\0${session}`) ?? null;
    },
  });
  return () => {
    claimed = undefined;
    return read();
  };
}
