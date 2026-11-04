import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '@stim-cli/core';
import {
  isJsonObject,
  parseInstalledPlist,
  parseLaunchctlPrint,
  parseSystemctlShow,
  parseUnit,
  readServerClientCounts,
  tailscaleEnv,
  SHOW_PROPERTIES,
  serverLocalSocket,
  stimBuildDigest,
  type InstalledService,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readLocalHello, readWebShares } from '../local-server.ts';
import { localMachineName } from '../offload/diagnosis.ts';
import {
  classifyServers,
  parseProcessRows,
  parseServerProcesses,
  type InstalledServerService,
  type ServerHealthReading,
  type ServerReading,
  type NetworkReading,
  type ServerSetup,
} from './server-setup.ts';
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

/** Whether a service file names the server script: `service install --label` accepts any label, so the file name says nothing. */
function mentionsServer(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes('stim-server');
  } catch {
    return false;
  }
}

async function readLaunchdServices(): Promise<InstalledServerService[]> {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.plist') && mentionsServer(join(dir, name)))
    : [];
  const exec = getExecutor();
  const services = await Promise.all(
    files.map(async (name): Promise<InstalledServerService | null> => {
      const json = await exec.runFileQuietAsync('plutil', ['-convert', 'json', '-o', '-', join(dir, name)], {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      let installed: InstalledService | null = null;
      try {
        installed = json === null ? null : parseInstalledPlist(JSON.parse(json));
      } catch {}
      if (!isServerService(installed)) return null;
      const printed = await exec.runFileQuietAsync(
        'launchctl',
        ['print', `gui/${process.getuid?.() ?? 501}/${installed.label}`],
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      return {
        manager: 'launchd',
        label: installed.label,
        installed,
        job: printed === null ? null : parseLaunchctlPrint(printed),
      };
    }),
  );
  return services.filter((service) => service !== null);
}

async function readSystemdServices(): Promise<InstalledServerService[]> {
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
  const services = await Promise.all(
    files.map(async (name): Promise<InstalledServerService | null> => {
      let installed: InstalledService | null = null;
      try {
        installed = parseUnit(readFileSync(join(dir, name), 'utf8'));
      } catch {}
      if (!isServerService(installed)) return null;
      const shown = await getExecutor().runFileQuietAsync(
        'systemctl',
        ['--user', 'show', name, '-p', SHOW_PROPERTIES],
        { timeoutMs: PROBE_TIMEOUT_MS, env },
      );
      return {
        manager: 'systemd',
        label: installed.label,
        installed,
        job: shown === null ? null : parseSystemctlShow(shown),
      };
    }),
  );
  return services.filter((service) => service !== null);
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
  const services = platform === 'darwin' ? await readLaunchdServices() : await readSystemdServices();
  const socket = existsSync(serverLocalSocket());
  if (processes.length === 0 && services.length === 0 && !socket) return null;
  const classified = classifyServers(processes, rows, services);
  const [servers, local, network] = await Promise.all([
    Promise.all(
      classified.map(async (server): Promise<ServerReading> =>
        Object.assign(server, { health: await readHealth(server.port) }),
      ),
    ),
    socket ? readLocalHello(version, HELLO_TIMEOUT_MS) : null,
    readNetwork(share, socket),
  ]);
  return {
    platform,
    stimHome: resolved(configDir()),
    version,
    build: stimBuildDigest(dirname(fileURLToPath(import.meta.url))),
    services,
    servers,
    local,
    clients: readServerClientCounts(),
    network,
    missingPaths: [...new Set(services.flatMap((service) => servicePaths(service.installed)))].filter(
      (path) => !existsSync(path),
    ),
  };
}
