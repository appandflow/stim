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
] as const;

/** Whether `finding` reports this machine's stim-server setup rather than the checkout. */
export const isServerFinding = (finding: Finding): boolean =>
  SERVER_FINDING_CODES.some((code) => code === finding.code);

const DEFAULT_SERVER_PORT = 7787;
const FLAPPING_RUNS = 3;

/** Who started a stim-server process: an installed service, Stim Desktop, `stim share`, or a person or script. */
export type ServerKind = 'service' | 'desktop' | 'share' | 'manual';

/** A running `stim-server` read from the process list. */
export interface ServerProcess {
  pid: number;
  ppid: number;
  command: string;
  /** The script the process runs, as its command line names it. */
  script: string;
  port: number;
  share: boolean;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** The `/health` fields doctor reads; everything is optional because a server older than a field omits it. */
export interface ServerHealthReading {
  version: string;
  stim: string;
  stimHome: string;
  startup?: { state: string };
  keepAwake?: { setting: boolean; held: boolean; reason?: string };
}

/** One installed service: its file, the job its manager runs, and the answer on its port. */
export interface InstalledServerService {
  manager: 'launchd' | 'systemd';
  label: string;
  installed: InstalledService;
  job: LaunchdJob | UnitJob | null;
}

export interface ServerReading extends ServerProcess {
  kind: ServerKind;
  /** The service label, for a `service` server. */
  label?: string;
  health: ServerHealthReading | null;
}

/** What the server at this Stim home's local socket said in `hello`. */
interface LocalServerReading {
  port: number | null;
  version: string;
  features: string[];
}

export interface ServerSetup {
  platform: 'darwin' | 'linux';
  /** This CLI's Stim home, resolved. */
  stimHome: string;
  /** The version of the stim running doctor. */
  version: string;
  services: InstalledServerService[];
  servers: ServerReading[];
  local: LocalServerReading | null;
  /** How many clients this machine's stim-server approved for builds and for hosted devices. */
  clients: { build: number; deviceHost: number };
}

/** The signed launcher a macOS service runs the server under: its command line repeats the server's, but the node child is the server. */
const STIM_HOST_LAUNCHER = /\/Contents\/MacOS\/stim-host run /;

const SERVER_COMMAND =
  /^(?:\S+\s)*?\S*[/\\]?node(?:\.exe)?\s+(?:-\S+\s+)*(.*?stim-server(?:\.mjs)?)(?=\s|$)(?:\s+(.*))?$/;

/**
 * The `stim-server` processes in `ps -axo pid=,ppid=,command=` output: node running the server script with no
 * subcommand. `stim-server service update` and the other subcommands are short-lived and not servers.
 */
export function parseServerProcesses(ps: string): ServerProcess[] {
  const servers: ServerProcess[] = [];
  for (const row of parseProcessRows(ps)) {
    if (STIM_HOST_LAUNCHER.test(row.command)) continue;
    const [, script, rest = ''] = SERVER_COMMAND.exec(row.command) ?? [];
    if (script === undefined) continue;
    const args = rest.split(/\s+/).filter(Boolean);
    if (args[0] !== undefined && !args[0].startsWith('-')) continue;
    if (args.includes('--version') || args.includes('--help')) continue;
    const port = Number(args[args.indexOf('--port') + 1]);
    servers.push({
      ...row,
      script,
      port: args.includes('--port') && Number.isInteger(port) ? port : DEFAULT_SERVER_PORT,
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

/**
 * Who started each server. A server is a service's when the service's job process, or a launcher it runs, is that
 * process or its ancestor; Stim Desktop's when it is the server bundled in an app or has a Desktop process as an
 * ancestor; `stim share`'s when it runs with `--share`; otherwise started by hand.
 */
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

const describe = (server: ServerReading): string => {
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

const labelFlag = (label: string): string => (label === 'dev.stim.server' ? '' : ` --label ${label}`);

/** `a` and `b` name one Stim home: equal after trailing slashes are dropped. Callers pass resolved paths. */
const sameHome = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * How to bring a server on another version to this CLI's: its service updates in place, Stim Desktop carries its own
 * server with the app, and a server started by hand restarts from the stim-server on PATH.
 */
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
    if (compared === null ? server.health.stim === setup.version : compared === 0) return [];
    const older = compared !== null && compared < 0;
    return [
      {
        code: 'server-version',
        level: 'note',
        title: `A stim-server runs stim ${server.health.stim}, but this machine's stim is ${setup.version}`,
        detail: `${describe(server)}. Remote builds need both machines on one build compatibility version, and a server of another version can refuse requests that a newer stim sends.`,
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
        detail: `${describe(server)} serves ${server.health.stimHome}; this stim uses ${setup.stimHome}. Commands here and the server read different state, so Desktop and paired devices do not see this checkout's workspaces. A scratch STIM_HOME produces the same difference on purpose.`,
        fix,
      },
    ];
  });
}

const exitCode = (job: LaunchdJob | UnitJob | null): number | null => {
  const text = job?.lastExitCode;
  if (!text) return null;
  const code = /^-?\d+$/.test(text) ? Number(text) : null;
  return code === 0 ? 0 : (code ?? NaN);
};

function serviceStateFindings(setup: ServerSetup): Finding[] {
  return setup.services.flatMap((service): Finding[] => {
    const { job, installed } = service;
    const server = setup.servers.find((each) => each.kind === 'service' && each.label === service.label);
    const log = installed.logPath ? ` The log is ${installed.logPath}.` : '';
    const rollback = installed.previousScript
      ? ` The previous server is still installed: \`stim-server service rollback${labelFlag(service.label)}\` switches back to it.`
      : '';
    const code = exitCode(job);
    const failed = code !== 0 && code !== null;
    const exit = failed ? `, and its last exit was ${Number.isNaN(code) ? job?.lastExitCode : code}` : '';
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

function multipleFindings(setup: ServerSetup): Finding[] {
  const groups = new Map<string, ServerReading[]>();
  for (const server of setup.servers) {
    const home = homeOf(server);
    if (server.kind === 'share' || home === null) continue;
    const key = [...groups.keys()].find((each) => sameHome(each, home)) ?? home;
    groups.set(key, [...(groups.get(key) ?? []), server]);
  }
  return [...groups].flatMap(([home, members]): Finding[] => {
    if (members.length < 2) return [];
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
        detail: `${members.map(describe).join('; ')}. Only one of them holds the Stim home's local socket, so Desktop and the CLI reach one while paired devices may reach another, and each keeps its own pairings in memory.${owner ? ` The server on port ${owner.port} holds the socket.` : ''}`,
        fix: `Keep ${describe(keep)}. ${steps.join(' ')}`,
      },
    ];
  });
}

function leftoverFindings(setup: ServerSetup): Finding[] {
  const grouped = new Set(
    multipleFindings(setup).length === 0
      ? []
      : setup.servers.filter((server) => server.kind !== 'share' && homeOf(server) !== null),
  );
  const loose = setup.servers.filter((server) => server.kind === 'manual' && !grouped.has(server));
  if (loose.length === 0) return [];
  const rows = loose.map((server) => `${describe(server)}${homeOf(server) ? `, Stim home ${homeOf(server)}` : ''}`);
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
      server.health?.keepAwake &&
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

/** The release that first advertises `desktop-local-authority` on a server without Desktop's private key. */
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
      detail: `${describe(owner)} runs ${local.version} and does not advertise ${DESKTOP_AUTHORITY_FEATURE}, so Stim Desktop reads from it but refuses to run actions through it (start, stop, reload, setup fixes).`,
      fix:
        owner.kind === 'service' && target
          ? `Run \`stim-server service update${labelFlag(owner.label ?? '')} --release ${target}\`.`
          : owner.kind === 'service'
            ? `Run \`stim-server service update${labelFlag(owner.label ?? '')} --release <version>\` with a version newer than ${local.version}.`
            : `Stop pid ${owner.pid} and start a newer \`stim-server\`, or install it as a service with \`stim-server service install\`.`,
    },
  ];
}

/** Every process-level and service-level finding about this machine's stim-server setup, in report order. */
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
