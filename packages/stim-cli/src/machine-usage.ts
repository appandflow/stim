import {
  MACHINE_OWNER_KINDS,
  type EnvironmentState,
  type MachineOwner,
  type MachineOwnerKind,
  type MachineUsageState,
  type StatsPlatform,
} from '@stim-cli/core/state';
import type { HostProcess } from './devices/activity.ts';

/** The processes of a workspace that status verified as its own. */
export interface WorkspaceProcessRoots {
  path: string;
  supervisorPid: number | null;
  build: { platform: StatsPlatform; pid: number } | null;
  browserPids: number[];
}

const SHARED: { name: string; pattern: RegExp }[] = [
  { name: 'CoreSimulator services', pattern: /\/CoreSimulator\.framework\/|\/Simulator\.app\/Contents\/MacOS\// },
  { name: 'adb server', pattern: /(^|\/)adb\s.*\bfork-server\b/ },
  { name: 'Android emulator services', pattern: /\/emulator\/netsimd(\s|$)/ },
  { name: 'Gradle daemon', pattern: /\borg\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon\b/ },
  { name: 'Kotlin daemon', pattern: /\bKotlinCompileDaemon\b/ },
  { name: 'Watchman', pattern: /(^|\/)watchman(\s|$)/ },
];

const SERVER = /(^|[\s/])stim-server(\.mjs)?(\s|$)/;
const LAUNCHD_SIM = /^launchd_sim\s.*\/Devices\/([^/\s]+)\//;
const MAX_DEPTH = 64;

const EMULATOR = /(?:^|\/)(?:qemu-system-[^\s/]+|emulator)(?:\s.*)?\s(?:-avd\s+|@)(\S+)/;

function emulatorAvd(command: string): string | null {
  return EMULATOR.exec(command)?.[1] ?? null;
}

type Owner = Omit<MachineOwner, 'cpuPercent' | 'residentMb' | 'processes'>;

function workspaceOwner(kind: MachineOwnerKind, env: EnvironmentState, name: string, id: string | null): Owner {
  return { kind, name, workspace: env.path, id, owned: true };
}

function rank(owner: MachineOwner): number {
  return MACHINE_OWNER_KINDS.indexOf(owner.kind);
}

/**
 * Attributes every process in `processes` to at most one owner: the owner of its nearest ancestor (itself included)
 * that is a root. Roots are each booted simulator's `launchd_sim`, each emulator launcher and qemu process, and each
 * workspace's verified supervisor and Metro, running build and Chrome. Only a process under none of those falls back
 * to stim-server or a machine-wide service in `SHARED`, so a `simctl` a workspace's log collector runs stays with the
 * workspace. A process with no root ancestor is left out.
 */
export function attributeMachineUsage({
  processes,
  environments,
  roots,
  simNames,
}: {
  processes: readonly HostProcess[];
  environments: readonly EnvironmentState[];
  roots: readonly WorkspaceProcessRoots[];
  simNames: Readonly<Record<string, string | undefined>>;
}): MachineUsageState {
  const owners = new Map<string, Owner>();
  const rootOf = new Map<number, string>();
  const fallbackOf = new Map<number, string>();
  const claim = (pid: number, key: string, owner: Owner, into = rootOf) => {
    if (!owners.has(key)) owners.set(key, owner);
    into.set(pid, key);
  };

  const sims = new Map<string, Owner>();
  const emulators = new Map<string, Owner>();
  for (const env of environments) {
    for (const device of [{ slot: 'default', ios: env.ios, android: env.android }, ...(env.slots ?? [])]) {
      const slot = device.slot === 'default' ? {} : { slot: device.slot };
      if (device.ios?.state === 'Booted') {
        sims.set(device.ios.udid.toUpperCase(), {
          kind: 'simulator',
          name: device.ios.name ?? device.ios.udid,
          workspace: env.path,
          ...slot,
          id: device.ios.udid,
          owned: device.ios.owned,
        });
      }
      if (device.android?.name && !device.android.physical && device.android.serial) {
        emulators.set(device.android.name, {
          kind: 'emulator',
          name: device.android.name,
          workspace: env.path,
          ...slot,
          id: device.android.name,
          owned: device.android.owned,
        });
      }
    }
  }

  for (const p of processes) {
    const shared = SHARED.find(({ pattern }) => pattern.test(p.command));
    if (shared) {
      const owner: Owner = { kind: 'shared', name: shared.name, workspace: null, id: null, owned: false };
      claim(p.pid, `shared:${shared.name}`, owner, fallbackOf);
      continue;
    }
    if (SERVER.test(p.command)) {
      const owner: Owner = { kind: 'server', name: 'stim-server', workspace: null, id: null, owned: false };
      claim(p.pid, 'server', owner, fallbackOf);
      continue;
    }
    const udid = LAUNCHD_SIM.exec(p.command)?.[1]?.toUpperCase();
    if (udid) {
      const owner = sims.get(udid) ?? {
        kind: 'simulator' as const,
        name: simNames[udid] ?? udid,
        workspace: null,
        id: udid,
        owned: false,
      };
      claim(p.pid, `simulator:${udid}`, owner);
      continue;
    }
    const avd = emulatorAvd(p.command);
    if (avd) {
      const owner = emulators.get(avd) ?? {
        kind: 'emulator' as const,
        name: avd,
        workspace: null,
        id: avd,
        owned: false,
      };
      claim(p.pid, `emulator:${avd}`, owner);
    }
  }

  const present = new Set(processes.map((p) => p.pid));
  const byPath = new Map(environments.map((env) => [env.path, env]));
  for (const root of roots) {
    const env = byPath.get(root.path);
    if (!env) continue;
    const metroPids = [root.supervisorPid, env.metro?.running ? env.metro.pid : null];
    for (const pid of metroPids) {
      if (pid && present.has(pid)) {
        const port = env.metro?.port ?? null;
        claim(
          pid,
          `metro:${env.path}`,
          workspaceOwner('metro', env, port ? `Metro :${port}` : 'Metro', port ? String(port) : null),
        );
      }
    }
    if (root.build && present.has(root.build.pid)) {
      const label = root.build.platform === 'ios' ? 'iOS build' : 'Android build';
      claim(root.build.pid, `build:${env.path}`, workspaceOwner('build', env, label, root.build.platform));
    }
    for (const pid of root.browserPids) {
      if (present.has(pid)) claim(pid, `browser:${env.path}`, workspaceOwner('browser', env, 'Chrome', null));
    }
  }

  const parentOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const totals = new Map<string, { rssKb: number; cpu: number; processes: number }>();
  for (const p of processes) {
    let pid: number | undefined = p.pid;
    let key: string | undefined;
    let fallback: string | undefined;
    for (let depth = 0; pid !== undefined && pid > 1 && depth < MAX_DEPTH; depth++) {
      key = rootOf.get(pid);
      if (key) break;
      fallback ??= fallbackOf.get(pid);
      pid = parentOf.get(pid);
    }
    key ??= fallback;
    if (!key) continue;
    const total = totals.get(key) ?? { rssKb: 0, cpu: 0, processes: 0 };
    total.rssKb += p.rssKb;
    total.cpu += p.cpuPercent;
    total.processes += 1;
    totals.set(key, total);
  }

  const list: MachineOwner[] = [];
  for (const [key, owner] of owners) {
    const total = totals.get(key);
    if (total)
      list.push({
        ...owner,
        cpuPercent: Math.round(total.cpu),
        residentMb: Math.round(total.rssKb / 1024),
        processes: total.processes,
      });
  }
  list.sort(
    (x, y) =>
      rank(x) - rank(y) || (x.workspace ?? '~').localeCompare(y.workspace ?? '~') || x.name.localeCompare(y.name),
  );
  return { owners: list };
}
