import type { InstalledService, LaunchdJob, UnitJob } from '@stim-cli/core/state';
import type { Finding } from './doctor.ts';
import { compareStimVersions } from './stim-installations.ts';

/** @internal The `code` of each finding this module reports, which the settings guide topic documents and its test reads. */
export const SERVER_FINDING_CODES = [
  'server-multiple',
  'server-service-crash',
  'server-desktop-authority',
  'server-version',
  'server-home',
  'server-leftover',
  'server-keep-awake',
  'server-tailscale',
  'server-tailscale-route',
  'server-funnel',
  'server-share-proxy',
  'server-tcp-lowat',
  'server-service-paths',
] as const;

export const isServerFinding = (finding: Finding): boolean =>
  SERVER_FINDING_CODES.some((code) => code === finding.code);

const DEFAULT_SERVER_PORT = 7787;
const FLAPPING_RUNS = 3;

export type ServerKind = 'service' | 'desktop' | 'share' | 'manual';

export interface ServerProcess {
  pid: number;
  ppid: number;
  command: string;
  script: string;
  port: number;
  share: boolean;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ServerHealthReading {
  version: string;
  stim: string;
  stimBuild?: string;
  stimHome: string;
  startup?: { state: string };
  keepAwake?: { setting: boolean; held: boolean; reason?: string };
  loopbackOnly?: boolean;
  lan?: boolean;
}

export interface InstalledServerService {
  manager: 'launchd' | 'systemd';
  label: string;
  installed: InstalledService;
  job: LaunchdJob | UnitJob | null;
}

export interface ServerReading extends ServerProcess {
  kind: ServerKind;
  label?: string;
  health: ServerHealthReading | null;
}

interface LocalServerReading {
  port: number | null;
  version: string;
  features: string[];
}

export interface ServerSetup {
  platform: 'darwin' | 'linux';
  stimHome: string;
  version: string;
  build: string | null;
  services: InstalledServerService[];
  servers: ServerReading[];
  local: LocalServerReading | null;
  clients: { build: number; deviceHost: number };
  /** Tailscale, share settings and kernel settings; read only when a server, service or socket exists. */
  network: NetworkReading;
  /** Paths a service file records (its node, server script, `--path-prepend` directories and path variables) that do not exist. */
  missingPaths: string[];
}

export interface NetworkReading {
  /** This machine's name as its peers see it. */
  host: string;
  /** `tailscale status --json` whatever its backend state; null when no tailscale command answered. */
  tailscaleStatus: unknown;
  /** `tailscale serve status --json`; null when Tailscale is not running or the config could not be read. */
  serve: unknown;
  share: { exposure: 'auto' | 'tailscale' | 'proxy'; publicUrl: string | null };
  /** The web shares this Stim home's server lists; null when none is reachable or none was read. */
  shares: Array<{ id: string; workspace: string; auth: 'generated' | 'set' | 'none' }> | null;
  /** Linux `net.ipv4.tcp_notsent_lowat`; null elsewhere or when unreadable. */
  notsentLowat: number | null;
}

/** The launcher a macOS service runs the server under repeats the server's command line; its node child is the server. */
const STIM_HOST_LAUNCHER = /\/Contents\/MacOS\/stim-host run /;

const SERVER_COMMAND = /^\S*[/\\]?node(?:\.exe)?\s+(?:-\S+\s+)*(.*?stim-server(?:\.mjs)?)(?=\s|$)(?:\s+(.*))?$/;
const SERVER_SCRIPT = /(?:^|\/)stim-server(?:\.mjs)?$/;

export function parseServerProcesses(ps: string): ServerProcess[] {
  const servers: ServerProcess[] = [];
  for (const row of parseProcessRows(ps)) {
    if (STIM_HOST_LAUNCHER.test(row.command)) continue;
    const [, script, rest = ''] = SERVER_COMMAND.exec(row.command) ?? [];
    if (script === undefined || !SERVER_SCRIPT.test(script)) continue;
    const args = rest.split(/\s+/).filter(Boolean);
    if (args[0] !== undefined && !args[0].startsWith('-')) continue;
    if (args.includes('--version') || args.includes('--help')) continue;
    const flag = args.findIndex((each) => each === '--port' || each.startsWith('--port='));
    const port = Number(args[flag]?.startsWith('--port=') ? args[flag]?.slice('--port='.length) : args[flag + 1]);
    servers.push({
      ...row,
      script,
      port: flag >= 0 && Number.isInteger(port) ? port : DEFAULT_SERVER_PORT,
      share: args.includes('--share'),
    });
  }
  return servers;
}

export function parseProcessRows(ps: string): ProcessRow[] {
  return ps.split('\n').flatMap((line) => {
    const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? [];
    return pid && ppid && command ? [{ pid: Number(pid), ppid: Number(ppid), command }] : [];
  });
}

const BUNDLED_SERVER = /\.app\/Contents\/Resources\/stim-server\//;

export function classifyServers(
  servers: readonly ServerProcess[],
  rows: readonly ProcessRow[],
  services: readonly InstalledServerService[],
): Array<ServerProcess & { kind: ServerKind; label?: string }> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestry = (pid: number): ProcessRow[] => {
    const chain: ProcessRow[] = [];
    for (let at = byPid.get(pid), depth = 0; at && depth < 32; at = byPid.get(at.ppid), depth += 1) chain.push(at);
    return chain;
  };
  return servers.map((server) => {
    const chain = ancestry(server.pid);
    const service = services.find((each) => each.job?.pid != null && chain.some((row) => row.pid === each.job?.pid));
    if (service) return { ...server, kind: 'service', label: service.label };
    if (server.share) return { ...server, kind: 'share' };
    if (
      BUNDLED_SERVER.test(server.script) ||
      chain.some((row) => /\/Contents\/MacOS\/StimDesktop(\s|$)/.test(row.command))
    )
      return { ...server, kind: 'desktop' };
    return { ...server, kind: 'manual' };
  });
}

export const describeServer = (server: ServerReading): string => {
  const who =
    server.kind === 'service'
      ? `the ${server.label ?? 'stim-server'} service`
      : server.kind === 'desktop'
        ? "Stim Desktop's bundled server"
        : server.kind === 'share'
          ? 'a `stim share` server'
          : 'a server someone started by hand';
  return `pid ${server.pid}, ${who}, port ${server.port}`;
};

export const labelFlag = (label: string): string => (label === 'dev.stim.server' ? '' : ` --label ${label}`);

export const sameHome = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

function updateRemedy(server: ServerReading, version: string): string {
  if (server.kind === 'service')
    return `Run \`stim-server service update${labelFlag(server.label ?? '')} --release ${version}\`.`;
  if (server.kind === 'desktop')
    return 'Update Stim Desktop; it bundles the server it runs. Or install a server separately with `stim-server service install` so Desktop adopts it.';
  return `Stop pid ${server.pid} and start \`stim-server\` from the installation on PATH again.`;
}

function versionFindings(setup: ServerSetup): Finding[] {
  return setup.servers.flatMap((server): Finding[] => {
    if (!server.health || server.kind === 'share') return [];
    const compared = compareStimVersions(server.health.stim, setup.version);
    if (compared === null ? server.health.stim === setup.version : compared === 0) {
      const { stimBuild } = server.health;
      if (!stimBuild || !setup.build || stimBuild === setup.build) return [];
      return [
        {
          code: 'server-version',
          level: 'note',
          title: `A stim-server runs another build of stim ${setup.version} than this machine's`,
          detail: `${describeServer(server)}. Both report ${setup.version}, but their builds differ (${stimBuild} and ${setup.build}), as with a checkout build beside a release; machines with another build compatibility version refuse each other's builds.`,
          fix: updateRemedy(server, setup.version),
        },
      ];
    }
    const older = compared !== null && compared < 0;
    return [
      {
        code: 'server-version',
        level: 'note',
        title: `A stim-server runs stim ${server.health.stim}, but this machine's stim is ${setup.version}`,
        detail: `${describeServer(server)}. Remote builds need both machines on one build compatibility version, and a server of another version can refuse requests that a newer stim sends.`,
        fix: older
          ? updateRemedy(server, setup.version)
          : `Update the \`stim\` on PATH to ${server.health.stim} with \`npm install --global stim@${server.health.stim}\`.`,
      },
    ];
  });
}

function homeFindings(setup: ServerSetup): Finding[] {
  return setup.servers.flatMap((server): Finding[] => {
    if (!server.health || server.kind === 'share' || sameHome(server.health.stimHome, setup.stimHome)) return [];
    const service = server.kind === 'service' ? setup.services.find((each) => each.label === server.label) : null;
    const fix = service
      ? `If the service should serve ${setup.stimHome}, run \`STIM_HOME=${setup.stimHome} stim-server service install${labelFlag(service.label)} --port ${server.port}\` again, repeating any --env and --path-prepend it was installed with (\`stim-server service status\` lists them). If ${server.health.stimHome} is the right home, unset STIM_HOME in this shell.`
      : `Run \`stim\` with STIM_HOME=${server.health.stimHome}, or stop the server and start it with STIM_HOME=${setup.stimHome}.`;
    return [
      {
        code: 'server-home',
        level: 'note',
        title: "A stim-server serves another Stim home than this stim's",
        detail: `${describeServer(server)} serves ${server.health.stimHome}; this stim uses ${setup.stimHome}. Commands here and the server read different state, so Desktop and paired devices do not see this checkout's workspaces. A scratch STIM_HOME produces the same difference on purpose.`,
        fix,
      },
    ];
  });
}

/** The exit a job last made: its code, `signal N` from systemd, or null for a job that has not exited (launchd prints `(never exited)`). */
const lastExit = (job: LaunchdJob | UnitJob | null): { failed: boolean; text: string } | null => {
  const text = job?.lastExitCode;
  if (!text) return null;
  if (/^-?\d+$/.test(text)) return { failed: Number(text) !== 0, text };
  return text.startsWith('signal') ? { failed: true, text } : null;
};

function serviceStateFindings(setup: ServerSetup): Finding[] {
  return setup.services.flatMap((service): Finding[] => {
    const { job, installed } = service;
    const server = setup.servers.find((each) => each.kind === 'service' && each.label === service.label);
    const log = installed.logPath ? ` The log is ${installed.logPath}.` : '';
    const rollback = installed.previousScript
      ? ` The previous server is still installed: \`stim-server service rollback${labelFlag(service.label)}\` switches back to it.`
      : '';
    const last = lastExit(job);
    const failed = last?.failed === true;
    const exit = failed ? `, and its last exit was ${last?.text}` : '';
    if (!job) {
      return [
        {
          code: 'server-service-crash',
          level: 'cost',
          title: `The ${service.label} service is installed but not running`,
          detail: `${service.manager === 'launchd' ? 'launchd' : 'systemd'} has no running job for ${service.label}, so nothing serves this Stim home through it.${log}`,
          fix:
            service.manager === 'launchd'
              ? `Run \`launchctl bootstrap gui/${process.getuid?.() ?? 501} ~/Library/LaunchAgents/${service.label}.plist\`, or remove the service with \`stim-server service uninstall${labelFlag(service.label)}\`.${rollback}`
              : `Run \`systemctl --user restart ${service.label}.service\`, or remove the service with \`stim-server service uninstall${labelFlag(service.label)}\`.${rollback}`,
        },
      ];
    }
    const runs = job.runs ?? 0;
    const down = job.pid === null || server === undefined || server.health === null;
    if (down && failed) {
      return [
        {
          code: 'server-service-crash',
          level: 'cost',
          title: `The ${service.label} service keeps stopping`,
          detail: `Its job has started ${runs} time${runs === 1 ? '' : 's'}${exit}, and it does not answer on port ${installed.port ?? DEFAULT_SERVER_PORT} now.${log}`,
          fix: `${installed.logPath ? `Read the end of ${installed.logPath} for the error. ` : ''}Fix what it reports, then restart the service.${rollback}`.trim(),
        },
      ];
    }
    if (failed && runs >= FLAPPING_RUNS) {
      return [
        {
          code: 'server-service-crash',
          level: 'note',
          title: `The ${service.label} service has restarted ${runs - 1} times`,
          detail: `It runs now (pid ${job.pid})${exit}. Repeated restarts end running builds and hosted devices.${log}`,
          fix: `${installed.logPath ? `Read ${installed.logPath} for what stopped it.` : 'Read its log for what stopped it.'}${rollback}`,
        },
      ];
    }
    return [];
  });
}

const homeOf = (server: ServerReading): string | null => server.health?.stimHome ?? null;

function homeGroups(setup: ServerSetup): Array<[string, ServerReading[]]> {
  const groups = new Map<string, ServerReading[]>();
  for (const server of setup.servers) {
    const home = homeOf(server);
    if (server.kind === 'share' || home === null) continue;
    const key = [...groups.keys()].find((each) => sameHome(each, home)) ?? home;
    groups.set(key, [...(groups.get(key) ?? []), server]);
  }
  return [...groups].filter(([, members]) => members.length >= 2);
}

function multipleFindings(setup: ServerSetup): Finding[] {
  return homeGroups(setup).flatMap(([home, members]): Finding[] => {
    const owner = setup.local?.port == null ? null : members.find((each) => each.port === setup.local?.port);
    const keep =
      members.find((each) => each.kind === 'service') ??
      owner ??
      members.find((each) => each.kind === 'desktop') ??
      members[0];
    if (!keep) return [];
    const others = members.filter((each) => each !== keep);
    const steps = others.map((each) =>
      each.kind === 'service'
        ? `Remove the ${each.label} service with \`stim-server service uninstall${labelFlag(each.label ?? '')}\`.`
        : each.kind === 'desktop'
          ? `Quit Stim Desktop, then open it with \`-stimServerPort ${keep.port}\` so it adopts the server on port ${keep.port} instead of starting its own.`
          : `Stop pid ${each.pid} with \`kill ${each.pid}\`.`,
    );
    return [
      {
        code: 'server-multiple',
        level: 'cost',
        title: `${members.length} stim-servers serve ${home}`,
        detail: `${members.map(describeServer).join('; ')}. Only one of them holds the Stim home's local socket, so Desktop and the CLI reach one while paired devices may reach another, and each keeps its own pairings in memory.${owner ? ` The server on port ${owner.port} holds the socket.` : ''}`,
        fix: `Keep ${describeServer(keep)}. ${steps.join(' ')}`,
      },
    ];
  });
}

function leftoverFindings(setup: ServerSetup): Finding[] {
  const grouped = new Set(homeGroups(setup).flatMap(([, members]) => members));
  const loose = setup.servers.filter((server) => server.kind === 'manual' && !grouped.has(server));
  if (loose.length === 0) return [];
  const rows = loose.map(
    (server) => `${describeServer(server)}${homeOf(server) ? `, Stim home ${homeOf(server)}` : ''}`,
  );
  return [
    {
      code: 'server-leftover',
      level: 'note',
      title: `${loose.length} stim-server${loose.length === 1 ? '' : 's'} started by hand ${loose.length === 1 ? 'is' : 'are'} running`,
      detail: `No installed service or Stim Desktop owns ${loose.length === 1 ? 'it' : 'them'}: ${rows.join('; ')}. A forgotten server holds its port and its Stim home's local socket. Doctor does not stop servers.`,
      fix: `If you do not need ${loose.length === 1 ? 'it' : 'one'}, stop it with \`kill ${loose.map((server) => server.pid).join(' ')}\`.`,
    },
  ];
}

function keepAwakeFindings(setup: ServerSetup): Finding[] {
  if (setup.platform !== 'darwin' || setup.clients.build + setup.clients.deviceHost === 0) return [];
  const sleepy = setup.servers.find(
    (server) =>
      server.kind !== 'share' &&
      server.health !== null &&
      sameHome(server.health.stimHome, setup.stimHome) &&
      server.health.keepAwake &&
      !server.health.keepAwake.held &&
      server.health.keepAwake.reason === 'off',
  );
  if (!sleepy) return [];
  const total = setup.clients.build + setup.clients.deviceHost;
  const kinds = [
    setup.clients.build ? `${setup.clients.build} for builds` : null,
    setup.clients.deviceHost ? `${setup.clients.deviceHost} for hosted devices` : null,
  ].filter(Boolean);
  return [
    {
      code: 'server-keep-awake',
      level: 'note',
      title: 'This Mac serves build or device clients but may sleep',
      detail: `${total} approved client${total === 1 ? '' : 's'} (${kinds.join(', ')}) use this Mac's stim-server, and \`server.keepAwake\` is off, so an idle Mac sleeps and drops their builds and sessions.`,
      fix: 'Run `stim settings set server.keepAwake true`; the server then holds a sleep assertion on AC power while it serves other machines. Confirm with `stim-server service status`.',
    },
  ];
}

const DESKTOP_AUTHORITY_FEATURE = 'desktop-local-authority';

function desktopAuthorityFindings(setup: ServerSetup): Finding[] {
  const local = setup.local;
  if (!local || local.features.includes(DESKTOP_AUTHORITY_FEATURE)) return [];
  const owner = setup.servers.find((server) => local.port !== null && server.port === local.port);
  if (!owner || owner.kind === 'desktop' || owner.kind === 'share') return [];
  const compared = compareStimVersions(local.version, setup.version);
  const target = compared !== null && compared < 0 ? setup.version : null;
  return [
    {
      code: 'server-desktop-authority',
      level: 'cost',
      title: "The stim-server on this Stim home's socket is too old for Desktop actions",
      detail: `${describeServer(owner)} runs ${local.version} and does not advertise ${DESKTOP_AUTHORITY_FEATURE}, so Stim Desktop reads from it but refuses to run actions through it (start, stop, reload, setup fixes).`,
      fix:
        owner.kind === 'service' && target
          ? `Run \`stim-server service update${labelFlag(owner.label ?? '')} --release ${target}\`.`
          : owner.kind === 'service'
            ? `Run \`stim-server service update${labelFlag(owner.label ?? '')} --release <version>\` with a version newer than ${local.version}.`
            : `Stop pid ${owner.pid} and start a newer \`stim-server\`, or install it as a service with \`stim-server service install\`.`,
    },
  ];
}

export function serverSetupFindings(setup: ServerSetup): Finding[] {
  return [
    ...multipleFindings(setup),
    ...serviceStateFindings(setup),
    ...versionFindings(setup),
    ...homeFindings(setup),
    ...desktopAuthorityFindings(setup),
    ...leftoverFindings(setup),
    ...keepAwakeFindings(setup),
  ];
}
