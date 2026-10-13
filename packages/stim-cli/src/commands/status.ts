import { maintenanceStatus, maintenanceLines } from '../maintenance/status.ts';
import { triggerMaintenance } from '../maintenance/trigger.ts';
import {
  createRefreshScheduler,
  WATCH_DEBOUNCE_MS,
  WATCH_FALLBACK_MS,
  WATCH_LIGHT_INTERVAL_MS,
  WATCH_MACHINE_INTERVAL_MS,
  WATCH_TABLES_INTERVAL_MS,
  watchChangeKey,
  watchPayload,
  watchStatusSources,
} from '../status-watch.ts';
import type { StatusSources } from '../status-watch.ts';
import { watchStdoutReader } from '../stdout-reader.ts';
import { iosStatusName, liveProbes, readStatus, refreshLightFacts, type StatusSnapshot } from '../status-read.ts';
import chalk from 'chalk';
import { statSync } from 'fs';
import { totalmem, userInfo } from 'os';
import { join } from 'path';
import type { Command } from 'commander';
import { getConfigDir } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { describeMetroLastStop } from '../supervisor/stop-cause.ts';
import { detectIsExpo, projectShortcut } from '../workspace/project.ts';
import { buildStatusLine } from '../engine/build-progress.ts';
import { formatBytes, volumeRootFor } from '../fs-util.ts';
import { formatDuration, plural } from '../command-output.ts';
import {
  withDerivedFacts,
  withGitChip,
  type AgentSession,
  type DeviceAppProcess,
  type DeviceIdleShutdownRecord,
  type LastBuildReport,
  type StatusPayload,
  archiveRoot,
  readArchives,
  type ArchivedWorkspace,
  DEVICE_RECLAIM_REASON,
} from '@stim-cli/core/state';
import { type DeviceActivity } from '../devices/activity.ts';
import {
  activityLabel,
  capacity,
  deviceLeaseLines,
  diskLine,
  gitSummaryText,
  parseDfFree,
  poolLine,
  remoteDeviceLine,
  tightVolumes,
} from '../status.ts';
import { createStatusMeasurer, type StatusMeasurer } from '../status-measures.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY, readParked } from '../devices/sim-pool.ts';
import type { EnvironmentState, VolumeInfo, WorktreeFacts } from '../status.ts';
import { physicalDeviceLine } from '../physical-devices.ts';

interface StatusOptions {
  json?: boolean;
  watch?: boolean;
}

function iosStatusLines(record: EnvironmentState['ios'], slotLabel: string): string[] {
  const out: string[] = [];
  const host = record?.udid ? record.host : undefined;
  const iosDevices: EnvironmentState['ios'][] = [
    record,
    ...(host
      ? [
          {
            host,
            name: host.device?.name ?? null,
            udid: '',
            owned: false,
            state: host.state ?? 'unverified',
          },
        ]
      : []),
  ];
  for (const ios of iosDevices) {
    if (!ios) continue;
    const booted = ios.state === 'Booted' ? chalk.green('booted') : chalk.dim(ios.state.toLowerCase());
    const owned = ios.owned ? chalk.dim(' (owned)') : '';
    out.push(
      `  ios${slotLabel}: ${chalk.cyan(iosStatusName(ios))} ${booted}${owned}${activitySuffix(ios.activity)}${appSuffix(ios.app)}${idleShutdownSuffix(ios.idleShutdown)}`,
    );
    if (!ios.udid && ios.host?.agent.driver === 'agent-device')
      out.push(chalk.dim(`    agent: ${ios.host.agent.command}`));
  }
  return out;
}

function androidStatusLines(record: EnvironmentState['android'], slotLabel: string): string[] {
  const out: string[] = [];
  if (record?.host && !record.serial) {
    const host = record.host;
    out.push(
      `  android${slotLabel}: ${chalk.cyan(`${host.device?.name ?? 'Android emulator'} on ${host.machine}${host.selected === 'auto' && host.reason ? ` (auto: ${host.reason})` : ''}`)} ${host.state ?? 'unverified'}`,
    );
  } else if (record) {
    const kind = record.physical ? chalk.dim('(physical)') : chalk.dim('(emulator)');
    const observed = record.state ? ` ${record.state}${record.serial ? ` (${record.serial})` : ''}` : '';
    out.push(
      `  android${slotLabel}: ${chalk.cyan(record.name)} ${kind}${observed}${record.owned ? chalk.dim(' (owned)') : ''}${activitySuffix(record.activity)}${appSuffix(record.app)}${idleShutdownSuffix(record.idleShutdown)}`,
    );
    if (record.host) {
      const host = record.host;
      out.push(
        `  android${slotLabel}: ${chalk.cyan(`${host.device?.name ?? 'Android emulator'} on ${host.machine}${host.selected === 'auto' && host.reason ? ` (auto: ${host.reason})` : ''}`)} ${host.state ?? 'unverified'}`,
      );
    }
  }
  if (record?.host?.agent.driver === 'agent-device') out.push(chalk.dim(`    agent: ${record.host.agent.command}`));
  return out;
}

function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

function phaseMarker({ phase, live, warmStep }: EnvironmentState): string {
  if (phase === 'warming') return chalk.cyan(` [warming: ${warmStep}]`);
  if (phase === 'ready') return chalk.green(' [ready]');
  return live ? '' : chalk.dim(' [idle]');
}

const WATCH_GIT_MAX_AGE_MS = 60_000;

export default function statusCommand(program: Command): void {
  program
    .command('status')
    .description(
      'Show every environment on this machine: devices, ports, what is actually running, and anything stuck.',
    )
    .option('--json', 'print the state as JSON')
    .option('--watch', 'keep running and print the state again each time it changes')
    .action(async (opts: StatusOptions) => {
      if (opts.watch) return watchStatus(Boolean(opts.json));
      const json = Boolean(opts.json);
      for (const line of renderStatus(await readStatus(), json)) console.log(line);
    });
}

function renderStatus(
  {
    archived,
    archivedUsage: usage,
    projects,
    states,
    labelOnlyRoots,
    leases,
    leaseNow,
    orphanWorktrees,
    simsAvailable,
    simctlError,
    cwdRoot,
    machine,
  }: StatusSnapshot,
  json: boolean,
  settle: (payload: StatusPayload) => StatusPayload = (payload) => payload,
  cwd = process.cwd(),
): string[] {
  const out: string[] = [];
  const totalMemoryMb = Math.round(totalmem() / (1024 * 1024));
  const cap = capacity(states, totalMemoryMb);
  const pools = (['ios', 'android'] as const).map((platform) => {
    const { max, error } = parkedMaxSetting(platform);
    return { error, line: poolLine({ platform, parked: readParked(platform).length, max }) };
  });

  const maintenance = maintenanceStatus();
  if (json) {
    const payload = {
      environments: states.map((state, i) =>
        withDerivedFacts(labelOnlyRoots[i] ? { ...state, labelOnly: true as const } : state),
      ),
      archived,
      archivedUsage: usage,
      capacity: cap,
      deviceLeases: leases,
      unprovisionedWorktrees: orphanWorktrees.map(withGitChip),
      simctlAvailable: simsAvailable,
      machine,
      maintenance,
    } satisfies StatusPayload;
    out.push(JSON.stringify(settle(payload)));
    return out;
  }

  out.push(...maintenanceLines(maintenance).map((line) => chalk.dim(line)));
  if (usage.count) out.push(`Archived: ${plural(usage.count, 'workspace')}, ${formatBytes(usage.bytes)}`);

  if (projects.length === 0 && orphanWorktrees.length === 0) {
    out.push(chalk.dim('No projects registered.'));
    for (const pool of pools) {
      if (pool.error) out.push(chalk.yellow(`${pool.error} ${POOL_SETTING_REMEDY}`));
      if (pool.line) out.push(chalk.dim(pool.line));
    }
    for (const line of deviceLeaseLines(leases, leaseNow)) out.push(line);
    return out;
  }

  if (!simsAvailable) {
    out.push(chalk.yellow(`simctl could not be read (${simctlError}), so no iOS sim below could be checked.`));
  }

  for (const [i, [path, proj]] of projects.entries()) {
    const state = states[i];
    if (!state) continue;
    const shortcut = projectShortcut(path, proj);
    const marker = path === cwdRoot ? chalk.bold.cyan(`* ${shortcut}`) : shortcut;
    const idle = phaseMarker(state);
    out.push(`\n${marker}${idle} ${chalk.dim(`(${path})`)}`);
    out.push(
      labelOnlyRoots[i]
        ? chalk.dim('  worktree root (holds the label; the app registers its own entry)')
        : chalk.dim(`  app: ${proj.bundleId ?? '?'} (${(proj.isExpo ?? detectIsExpo(path)) ? 'expo' : 'bare'})`),
    );

    if (state.metro) {
      const label = state.metro.running
        ? chalk.green(`running (pid ${state.metro.pid})`)
        : state.metro.idleStop
          ? chalk.dim(
              `stopped (idle) after ${state.metro.idleStop.idleMinutes}m; \`stim start\`, \`ios\` or \`android\` restarts it`,
            )
          : state.metro.lastStop
            ? chalk.dim(
                `not running${state.metro.lastStop.reason === 'vanished' ? '' : ` since ${state.metro.lastStop.at}`}; ${describeMetroLastStop(state.metro.lastStop)}`,
              )
            : chalk.dim('not running');
      out.push(`  metro: port ${state.metro.port} ${label}`);
      if (state.metro.tunnel) {
        const { provider, url } = state.metro.tunnel;
        out.push(`  tunnel: ${provider}${provider === 'tailscale' ? ' (tailnet-only)' : ''} ${url}`);
      }
    }
    if (state.supervisor) {
      const health = state.supervisor.healthy ? chalk.green('healthy') : chalk.yellow('not answering');
      const mode = state.supervisor.mode ? chalk.dim(` (${state.supervisor.mode})`) : '';
      out.push(`  supervisor: pid ${state.supervisor.pid}${mode} ${health}`);
    }
    if (state.build) {
      const line = `  ${buildStatusLine(state.build, Date.now())}`;
      out.push(state.build.state === 'running' ? line : chalk.yellow(line));
    }
    out.push(...lastBuildsLines(state.lastBuilds));
    if (state.worktree?.git) out.push(chalk.dim(`  git: ${gitSummaryText(state.worktree.git)}`));
    for (const agent of state.agents ?? []) out.push(chalk.dim(`  agent: ${agentLine(agent)}`));
    if (state.logs) {
      const n = state.logs.errorsSinceMarker;
      const errs = n > 0 ? chalk.yellow(` (${n} error${n === 1 ? '' : 's'} since the last marker)`) : '';
      out.push(chalk.dim(`  logs: ${state.logs.dir}`) + errs);
    }
    for (const deviceState of [{ slot: 'default', ios: state.ios, android: state.android }, ...(state.slots ?? [])]) {
      const slotLabel = deviceState.slot === 'default' ? '' : ` [${deviceState.slot}]`;
      out.push(...iosStatusLines(deviceState.ios, slotLabel));
      out.push(...androidStatusLines(deviceState.android, slotLabel));
    }
    if (state.macos) {
      const host = state.macos.host;
      const where = host ? ` on ${host.machine} as ${host.bundleId}${chalk.dim(` (session ${host.session})`)}` : '';
      const build = state.macos.build;
      const placement =
        build.buildMachine === undefined
          ? ''
          : `; build placement ${build.buildMachine}, built on ${build.builtOn ?? 'none'}`;
      out.push(`  macOS ${state.macos.product}: ${state.macos.state}${where}; build ${build.state}${placement}`);
      if (host?.agent.driver === 'agent-device') out.push(chalk.dim(`    agent: ${host.agent.command}`));
    }
    if (state.web) {
      const browser = state.web.running
        ? chalk.green(`running (pid ${state.web.pid}, DevTools ${state.web.cdpEndpoint})`)
        : chalk.dim('not running');
      const page = state.web.page;
      const failed = page?.state === 'failed' ? ` -- ${chalk.yellow(`page failed: ${page.error}`)}` : '';
      out.push(
        `  web: ${chalk.cyan(page?.url ?? state.web.url)} ${browser}${state.web.headless ? '' : chalk.dim(' (headed)')}${activitySuffix(state.web.activity)}${failed}`,
      );
    }
    for (const device of state.physicalDevices ?? []) out.push(`  ${physicalDeviceLine(device, leaseNow)}`);
    for (const remote of state.remoteDevices ?? []) out.push(`  ${remoteDeviceLine(remote)}`);
    for (const w of state.warnings) out.push(chalk.yellow(`  ! ${w}`));
    for (const note of state.issues.filter((issue) => issue.severity === 'info')) {
      out.push(chalk.dim(`  - ${note.message}`));
    }
  }

  for (const pool of pools) {
    if (pool.error) out.push(chalk.yellow(`\n${pool.error} ${POOL_SETTING_REMEDY}`));
    if (pool.line) out.push(chalk.dim(`\n${pool.line}`));
  }

  const leaseLines = deviceLeaseLines(leases, leaseNow);
  if (leaseLines.length) {
    out.push('');
    for (const line of leaseLines) out.push(line);
  }

  if (orphanWorktrees.length) {
    out.push(chalk.dim(`\nWorktrees with no environment (${orphanWorktrees.length}):`));
    for (const w of orphanWorktrees) out.push(chalk.dim(`  ${orphanWorktreeLine(w)}`));
  }

  out.push(
    chalk.dim(
      machine?.memorySource === 'footprint'
        ? `\n${cap.liveCount} active environment(s) use ${formatGb(cap.committedMb)} of ${formatGb(cap.totalMemoryMb)}.`
        : `\n${cap.liveCount} active environment(s), roughly ${formatGb(cap.committedMb)} of ${formatGb(cap.totalMemoryMb)} committed.`,
    ),
  );
  const volumes = readVolumes(cwdRoot || cwd);
  const line = diskLine(volumes);
  if (line) {
    const tight = tightVolumes(volumes);
    if (tight.length) {
      const which = tight.map((v) => v.volume).join(' and ');
      out.push(
        chalk.yellow(
          `${line} A single iOS build can exhaust ${which} -- run \`stim gc\` before starting another environment.`,
        ),
      );
    } else {
      out.push(chalk.dim(line));
    }
  }
  if (cap.overCapacity) {
    out.push(
      chalk.yellow(
        'Over comfortable capacity. A machine that swaps is slower than one working in sequence -- release one before starting another.',
      ),
    );
  }
  return out;
}

function watchedPids({ roots, states }: StatusSnapshot): number[] {
  return [
    ...roots.flatMap((root) => [
      ...(root.supervisorPid ? [root.supervisorPid] : []),
      ...(root.build ? [root.build.pid] : []),
      ...root.browserPids,
      ...(root.macosPids ?? []),
    ]),
    ...states.flatMap((state) => (state.metro?.running && state.metro.pid ? [state.metro.pid] : [])),
  ];
}

export interface StatusWatch {
  stop(): void;
}

/**
 * Reads status now and again on every change until stopped, and calls `emit` with each new rendering: the JSON payload
 * with `json`, the human view otherwise. `emit` never sees the same rendering twice in a row. `cwd` stands for the
 * directory status runs in, which marks the current workspace.
 */
export function runStatusWatch({
  json,
  cwd = process.cwd(),
  emit,
  failed,
}: {
  json: boolean;
  cwd?: string;
  emit: (text: string) => void;
  failed: (message: string) => void;
}): StatusWatch {
  let last: string | null = null;
  let lastPayload: StatusPayload | null = null;
  let archiveStamp: number | null = null;
  let archives: ArchivedWorkspace[] | undefined;
  let snapshot: StatusSnapshot | null = null;
  let sources: StatusSources | null = null;
  let tablesAt = 0;
  let machineDue = false;
  const measurer: StatusMeasurer = createStatusMeasurer({ updated: () => scheduler.trigger('light') });
  const scheduler = createRefreshScheduler({
    debounceMs: WATCH_DEBOUNCE_MS,
    lightIntervalMs: WATCH_LIGHT_INTERVAL_MS,
    run: async (kind) => {
      triggerMaintenance('status-watch');
      let text: string;
      let payload = null as StatusPayload | null;
      try {
        const now = Date.now();
        if (kind === 'light' && snapshot) {
          const machine = json && machineDue;
          const tables = machine || now - tablesAt >= WATCH_TABLES_INTERVAL_MS;
          machineDue = false;
          await refreshLightFacts(snapshot, { tables, machine });
          if (tables) tablesAt = now;
        } else {
          let stamp: number | null = null;
          try {
            stamp = statSync(archiveRoot()).mtimeMs;
          } catch {}
          if (archives === undefined || stamp !== archiveStamp) {
            archives = readArchives();
            archiveStamp = stamp;
          }
          const first = snapshot === null;
          snapshot = await readStatus({
            git: first ? 'none' : 'all',
            cwd,
            probes: liveProbes({
              simctlListing: sources?.simulatorListing(),
              gitMaxAgeMs: WATCH_GIT_MAX_AGE_MS,
              archives,
            }),
          });
          tablesAt = now;
          machineDue = false;
          sources?.watchRepositories(snapshot.gitCommonDirs);
          sources?.watchProcesses(watchedPids(snapshot));
          if (first) scheduler.trigger('full', 0);
        }
        measurer.schedule(snapshot.states, snapshot.worktrees);
        text = renderStatus(snapshot, json, (full) => (payload = watchPayload(lastPayload, full)), cwd).join('\n');
      } catch (error) {
        failed(String((error as Error)?.message || error));
        return;
      } finally {
        sources?.reconcile();
      }
      const key = json && payload ? watchChangeKey(payload) : text;
      if (key === last) return;
      last = key;
      lastPayload = payload;
      emit(text);
    },
  });
  const fallback = setInterval(() => scheduler.trigger('full'), WATCH_FALLBACK_MS);
  const machine = setInterval(() => {
    if (!json || !snapshot?.machine) return;
    machineDue = true;
    scheduler.trigger('light');
  }, WATCH_MACHINE_INTERVAL_MS);
  sources = watchStatusSources({
    home: getConfigDir(),
    deviceSet:
      process.platform === 'darwin'
        ? join(userInfo().homedir, 'Library', 'Developer', 'CoreSimulator', 'Devices')
        : null,
    onChange: (kind) => scheduler.trigger(kind),
  });
  scheduler.trigger('full', 0);
  return {
    stop() {
      clearInterval(fallback);
      clearInterval(machine);
      scheduler.stop();
      sources?.stop();
    },
  };
}

async function watchStatus(json: boolean): Promise<void> {
  const finish = () => {
    stopReader();
    watch.stop();
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  const watch = runStatusWatch({
    json,
    emit: (text) => process.stdout.write(`${!json && process.stdout.isTTY ? '\x1b[2J\x1b[H' : ''}${text}\n`),
    failed: (message) => console.error(chalk.red(message)),
  });
  const stopReader = watchStdoutReader(finish);
  await new Promise<never>(() => {});
}

function agentLine({ tool, title, sessionId, lastActiveAt }: AgentSession): string {
  const at = lastActiveAt ? `, active ${lastActiveAt}` : '';
  return `${tool === 'codex' ? 'Codex' : 'Claude Code'} ${title ? `"${title}"` : sessionId}${at}`;
}

function orphanWorktreeLine(w: WorktreeFacts): string {
  return `${w.path}${w.branch ? ` [${w.branch}]` : ''}${w.git ? ` -- ${gitSummaryText(w.git)}` : ''}`;
}

function lastBuildsLines(reports: EnvironmentState['lastBuilds']): string[] {
  const texts = Object.values(reports ?? {}).map(lastBuildText);
  return texts.length ? [chalk.dim(`  last build: ${texts.join(', ')}`)] : [];
}

function lastBuildText(report: LastBuildReport): string {
  const source = report.cacheHit ? `${report.cacheHit} cache` : report.status === 'ok' ? 'compiled' : 'no cache hit';
  const took = report.durationMs === null ? '' : ` in ${formatDuration(report.durationMs)}`;
  const placement =
    report.buildMachine === undefined
      ? ''
      : `; build placement ${report.buildMachine}, built on ${report.builtOn ?? (report.cacheHit ? 'none (cache)' : 'none')}`;
  return `${report.platform} ${report.status === 'ok' ? source : `failed (${report.errorCode ?? 'error'}), ${source}`}${took}${placement}`;
}

function idleShutdownSuffix(record: DeviceIdleShutdownRecord | undefined): string {
  return record
    ? chalk.dim(
        ` -- shut down after ${record.idleMinutes}m idle at ${record.at} (${record.reason === DEVICE_RECLAIM_REASON ? 'reclaimed for a waiting run; devices.reclaimIdleMinutes' : 'devices.idleShutdownMinutes'})`,
      )
    : '';
}

function activitySuffix(activity: DeviceActivity | undefined): string {
  const label = activityLabel(activity, Date.now());
  return label ? ` -- ${activity?.state === 'driven' ? chalk.magenta(label) : chalk.dim(label)}` : '';
}

function appSuffix(app: DeviceAppProcess | undefined): string {
  if (!app) return '';
  if (app.state === 'running') return chalk.dim(` -- ${app.id} running`);
  if (app.state === 'stopped') return ` -- ${chalk.yellow(`${app.id} not running`)}`;
  return chalk.dim(` -- ${app.id} process unknown`);
}

export function readVolumes(projectPath: string): VolumeInfo[] {
  const roots = [...new Set(['/', volumeRootFor(getConfigDir()), volumeRootFor(projectPath)])];
  const volumes: VolumeInfo[] = [];
  for (const volume of roots) {
    const disk = parseDfFree(getExecutor().runFileQuiet('df', ['-k', volume], { timeoutMs: 5000 }));
    if (disk) volumes.push({ volume, disk });
  }
  return volumes;
}
