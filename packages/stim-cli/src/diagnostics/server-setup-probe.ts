import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, dropInExecStart } from '@stim-cli/core';
import { staleLaunchAgent, staleSystemdUnit } from '@stim-cli/server/service-plist';
import {
  isJsonObject,
  parseInstalledPlist,
  parseLaunchctlPrint,
  parseSystemctlShow,
  parseUnit,
  readServerClientCounts,
  tailscaleEnv,
  SHOW_PROPERTIES,
  stimdRecordFile,
  stimdSocket,
  readJsonObject,
  stimBuildDigest,
  type InstalledService,
} from '@stim-cli/core/state';
import { androidHome, avdStorageRoots } from '../devices/android.ts';
import { engineRoot } from '../engine-store/store.ts';
import { getExecutor } from '../exec.ts';
import { readLocalHello, readWebShares } from '../local-server.ts';
import { localMachineName } from '../offload/diagnosis.ts';
import {
  classifyServers,
  parseProcessRows,
  parseServerProcesses,
  type InstalledServerService,
  type KillModeOverride,
  type StaleService,
  type ServerHealthReading,
  type ServerReading,
  type NetworkReading,
  type PermissionReading,
  type ServerSetup,
  type SocketReading,
} from './server-setup.ts';
import { volumeDenialSinceStart } from './server-permissions.ts';
import { servicePaths } from './server-toolchain.ts';

const PROBE_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 1500;
const HELLO_TIMEOUT_MS = 1500;
const TAILSCALE_TIMEOUT_MS = 3000;
const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const LOWAT_FILE = '/proc/sys/net/ipv4/tcp_notsent_lowat';

const isServerService = (installed: InstalledService | null): installed is InstalledService =>
  installed !== null && (installed.script ?? '').includes('stim-server');

const resolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Whether a service file names the server script or carries `marker`: `service install --label` accepts any label, so
 * the file name says nothing.
 */
function mentionsServer(file: string, marker = 'stim-server'): boolean {
  try {
    const text = readFileSync(file, 'utf8');
    return text.includes('stim-server') || text.includes(marker);
  } catch {
    return false;
  }
}

/** The server services, as `isServerService` finds them, and the managed LaunchAgents whose definition is stale. */
async function readLaunchdServices(): Promise<{ services: InstalledServerService[]; stale: StaleService[] }> {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.plist') && mentionsServer(join(dir, name), 'StimService'))
    : [];
  const exec = getExecutor();
  const read = await Promise.all(
    files.map(async (name): Promise<(InstalledServerService & { stale: string | null }) | null> => {
      const json = await exec.runFileQuietAsync('plutil', ['-convert', 'json', '-o', '-', join(dir, name)], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      let installed: InstalledService | null = null;
      try {
        installed = json === null ? null : parseInstalledPlist(JSON.parse(json));
      } catch {}
      if (installed === null || (!installed.managed && !isServerService(installed))) return null;
      const printed = await exec.runFileQuietAsync(
        'launchctl',
        ['print', `gui/${process.getuid?.() ?? 501}/${installed.label}`],
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      const job = printed === null ? null : parseLaunchctlPrint(printed);
      const shim = join(engineRoot(process.env), 'bin', 'stimd');
      return {
        manager: 'launchd',
        label: installed.label,
        installed,
        job,
        stale: installed.managed
          ? staleLaunchAgent(installed, job?.arguments ?? null, existsSync(shim) ? shim : null)
          : null,
      };
    }),
  );
  const found = read.filter((service) => service !== null);
  return {
    services: found
      .filter(({ installed }) => isServerService(installed))
      .map(({ stale: _stale, ...service }) => service),
    stale: found.flatMap(({ label, installed, stale }) => (stale ? [{ label, installed, reason: stale }] : [])),
  };
}

/**
 * The server services, as `isServerService` finds them, the managed units whose file does not set `KillMode=process`,
 * and the managed units whose file sets it while systemd has another mode loaded.
 */
async function readSystemdServices(): Promise<{
  services: InstalledServerService[];
  stale: StaleService[];
  killModeOverrides: KillModeOverride[];
}> {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.service') && mentionsServer(join(dir, name)))
    : [];
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
  };
  const read = await Promise.all(
    files.map(
      async (
        name,
      ): Promise<(InstalledServerService & { stale: string | null; loadedKillMode: string | null }) | null> => {
        let installed: InstalledService | null = null;
        let text = '';
        try {
          text = readFileSync(join(dir, name), 'utf8');
          installed = parseUnit(text);
        } catch {}
        if (installed === null || (!installed.managed && !isServerService(installed))) return null;
        const shown = await getExecutor().runFileQuietAsync(
          'systemctl',
          ['--user', 'show', name, '-p', SHOW_PROPERTIES],
          { timeoutMs: PROBE_TIMEOUT_MS, env },
        );
        const override = dropInExecStart(join(dir, name));
        const shim = join(engineRoot(process.env), 'bin', 'stimd');
        const stale = installed.managed ? staleSystemdUnit(installed, text, existsSync(shim) ? shim : null) : null;
        const loadedKillMode =
          installed.managed && stale === null
            ? await getExecutor().runFileQuietAsync(
                'systemctl',
                ['--user', 'show', name, '-p', 'KillMode', '--value'],
                {
                  timeoutMs: PROBE_TIMEOUT_MS,
                  env,
                },
              )
            : null;
        return {
          manager: 'systemd',
          label: installed.label,
          installed,
          job: shown === null ? null : parseSystemctlShow(shown),
          override: override ?? undefined,
          stale,
          loadedKillMode: loadedKillMode?.trim() ?? null,
        };
      },
    ),
  );
  const found = read.filter((service) => service !== null);
  return {
    services: found
      .filter(({ installed }) => isServerService(installed))
      .map(({ stale: _stale, loadedKillMode: _loaded, ...service }) => service),
    stale: found.flatMap(({ label, installed, stale }) => (stale ? [{ label, installed, reason: stale }] : [])),
    killModeOverrides: found.flatMap(({ label, loadedKillMode }) =>
      loadedKillMode && loadedKillMode !== 'process' ? [{ label, loaded: loadedKillMode }] : [],
    ),
  };
}

async function readHealth(port: number): Promise<ServerHealthReading | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body: unknown = await response.json();
    if (!isJsonObject(body) || body.server !== 'stim-server') return null;
    if (typeof body.version !== 'string' || typeof body.stim !== 'string' || typeof body.stimHome !== 'string')
      return null;
    const keep = isJsonObject(body.keepAwake) ? body.keepAwake : null;
    return {
      version: body.version,
      stim: body.stim,
      ...(typeof body.stimBuild === 'string' ? { stimBuild: body.stimBuild } : {}),
      stimHome: resolved(body.stimHome),
      ...(isJsonObject(body.startup) && typeof body.startup.state === 'string'
        ? { startup: { state: body.startup.state } }
        : {}),
      ...(body.loopbackOnly === true ? { loopbackOnly: true } : {}),
      ...(isJsonObject(body.host) &&
      typeof body.host.name === 'string' &&
      typeof body.host.screenRecording === 'boolean' &&
      typeof body.host.accessibility === 'boolean'
        ? {
            host: {
              name: body.host.name,
              screenRecording: body.host.screenRecording,
              accessibility: body.host.accessibility,
            },
          }
        : {}),
      ...(isJsonObject(body.lan) ? { lan: true } : {}),
      ...(keep && typeof keep.setting === 'boolean' && typeof keep.held === 'boolean'
        ? {
            keepAwake: {
              setting: keep.setting,
              held: keep.held,
              ...(typeof keep.reason === 'string' ? { reason: keep.reason } : {}),
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

async function tailscaleJson(args: string[]): Promise<unknown> {
  const env = Object.fromEntries(
    Object.entries(tailscaleEnv(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = await getExecutor().runFileQuietAsync(binary, args, { timeoutMs: TAILSCALE_TIMEOUT_MS, env });
    if (output === null) continue;
    try {
      return output.trim() === '' ? {} : JSON.parse(output);
    } catch {
      return null;
    }
  }
  return null;
}

async function readNetwork(share: NetworkReading['share'], socket: boolean): Promise<NetworkReading> {
  const status = await tailscaleJson(['status', '--json']);
  const running = isJsonObject(status) && status.BackendState === 'Running';
  const [serve, shares] = await Promise.all([
    running ? tailscaleJson(['serve', 'status', '--json']) : null,
    socket ? readWebShares() : null,
  ]);
  let lowat: number | null = null;
  if (process.platform === 'linux') {
    try {
      lowat = Number(readFileSync(LOWAT_FILE, 'utf8').trim());
    } catch {}
  }
  return {
    host: localMachineName(status),
    tailscaleStatus: status,
    serve: isJsonObject(serve) ? serve : null,
    share,
    shares: Array.isArray(shares) ? shares.map(({ id, workspace, auth }) => ({ id, workspace, auth })) : null,
    notsentLowat: Number.isFinite(lowat) ? lowat : null,
  };
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

/** stimd's CLI socket, as `run/stimd.json` names it, or where stimd binds it. */
function cliSocket(): string {
  const socket = readJsonObject(stimdRecordFile())?.socket;
  return typeof socket === 'string' ? socket : stimdSocket();
}

function readSocket(): SocketReading | null {
  const path = cliSocket();
  const dir = lstatOrNull(dirname(path));
  const socket = lstatOrNull(path);
  return {
    path,
    dir: dir && { isDirectory: dir.isDirectory(), mode: dir.mode, uid: dir.uid },
    socket: socket && { mode: socket.mode, uid: socket.uid },
    uid: process.getuid?.() ?? -1,
  };
}

const CURRENT_MACOS_MAJOR = 27;
const LOG_TAIL_BYTES = 64 * 1024;

function logTail(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function readPermissions(services: InstalledServerService[]): Promise<PermissionReading> {
  const version = await getExecutor().runFileQuietAsync('/usr/bin/sw_vers', ['-productVersion'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const external: PermissionReading['external'] = [];
  const seen = new Set<string>();
  for (const root of [androidHome(), ...avdStorageRoots()]) {
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      continue;
    }
    if (!real.startsWith('/Volumes/') || seen.has(real)) continue;
    seen.add(real);
    try {
      readdirSync(real);
      external.push({ path: real, blocked: false });
    } catch (error) {
      external.push({ path: real, blocked: error instanceof Error && 'code' in error && error.code === 'EPERM' });
    }
  }
  return {
    macosMajor: Number(version?.trim().split('.')[0]) || CURRENT_MACOS_MAJOR,
    doctorApp: process.env.STIM_DESKTOP_APP ? 'Stim Desktop' : null,
    external,
    logDenials: services.flatMap(({ label, installed }) => {
      const line = volumeDenialSinceStart(logTail(installed.logPath ?? ''));
      return line ? [{ label, line }] : [];
    }),
  };
}

async function readLinger(services: InstalledServerService[]): Promise<{ user: string; enabled: boolean } | null> {
  if (!services.some((service) => service.manager === 'systemd')) return null;
  const user = userInfo().username;
  const shown = await getExecutor().runFileQuietAsync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return shown === null ? null : { user, enabled: shown.trim() === 'yes' };
}

export async function readServerSetup(
  version: string,
  share: NetworkReading['share'] = { exposure: 'auto', publicUrl: null },
): Promise<ServerSetup | null> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const ps = await getExecutor().runFileQuietAsync('ps', ['-axo', 'pid=,ppid=,command='], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const rows = parseProcessRows(ps ?? '');
  const processes = parseServerProcesses(ps ?? '');
  const { services, stale, killModeOverrides } =
    platform === 'darwin' ? { ...(await readLaunchdServices()), killModeOverrides: [] } : await readSystemdServices();
  const socket = existsSync(cliSocket());
  const hasServer = processes.length > 0 || services.length > 0 || killModeOverrides.length > 0 || socket;
  if (!hasServer && stale.length === 0) return null;
  const classified = classifyServers(processes, rows, services);
  const [servers, local, network, permissions, linger] = await Promise.all([
    Promise.all(
      classified.map(async (server): Promise<ServerReading> =>
        Object.assign(server, { health: await readHealth(server.port) }),
      ),
    ),
    socket ? readLocalHello(version, HELLO_TIMEOUT_MS) : null,
    hasServer
      ? readNetwork(share, socket)
      : ({
          host: '',
          tailscaleStatus: null,
          serve: null,
          share: { exposure: 'auto', publicUrl: null },
          shares: null,
          notsentLowat: null,
        } satisfies NetworkReading),
    hasServer && platform === 'darwin' ? readPermissions(services) : null,
    platform === 'linux' ? readLinger(services) : null,
  ]);
  return {
    platform,
    stimHome: resolved(configDir()),
    version,
    build: stimBuildDigest(dirname(fileURLToPath(import.meta.url))),
    services,
    staleServices: stale,
    killModeOverrides,
    servers,
    local,
    clients: hasServer ? readServerClientCounts() : { build: 0, deviceHost: 0 },
    network,
    socket: socket ? readSocket() : null,
    permissions,
    linger,
    missingPaths: [...new Set(services.flatMap((service) => servicePaths(service.installed)))].filter(
      (path) => !existsSync(path),
    ),
  };
}
