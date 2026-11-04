import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir } from '@stim-cli/core';
import {
  isJsonObject,
  parseInstalledPlist,
  parseLaunchctlPrint,
  parseSystemctlShow,
  parseUnit,
  readServerClientCounts,
  SHOW_PROPERTIES,
  serverLocalSocket,
  type InstalledService,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readLocalHello } from '../local-server.ts';
import {
  classifyServers,
  parseProcessRows,
  parseServerProcesses,
  type InstalledServerService,
  type ServerHealthReading,
  type ServerReading,
  type ServerSetup,
} from './server-setup.ts';

const PROBE_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 1500;
const HELLO_TIMEOUT_MS = 1500;

const isServerService = (installed: InstalledService | null): installed is InstalledService =>
  installed !== null && (installed.script ?? '').includes('stim-server');

const resolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

async function readLaunchdServices(): Promise<InstalledServerService[]> {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.plist') && /stim/i.test(name)) : [];
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
    ? readdirSync(dir).filter((name) => name.endsWith('.service') && /stim/i.test(name))
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
      stimHome: resolved(body.stimHome),
      ...(isJsonObject(body.startup) && typeof body.startup.state === 'string'
        ? { startup: { state: body.startup.state } }
        : {}),
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

/**
 * Reads this machine's stim-server setup: installed services, running servers with their `/health`, and the server
 * on this Stim home's local socket. Null when there is no sign of a server, so a machine without one pays only for
 * the process list. Only macOS and Linux have services doctor reads.
 */
export async function readServerSetup(version: string): Promise<ServerSetup | null> {
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
  const [servers, local] = await Promise.all([
    Promise.all(
      classified.map(async (server): Promise<ServerReading> =>
        Object.assign(server, { health: await readHealth(server.port) }),
      ),
    ),
    socket ? readLocalHello(version, HELLO_TIMEOUT_MS) : null,
  ]);
  return {
    platform,
    stimHome: resolved(configDir()),
    version,
    services,
    servers,
    local,
    clients: readServerClientCounts(),
  };
}
