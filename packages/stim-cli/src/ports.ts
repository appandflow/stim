import { request } from 'http';
import { existsSync } from 'fs';
import { loadConfig, allMetroPorts, releaseMetroPort, claimMetroPort } from './workspace/config.ts';
import { isOnMountedVolume, listMountedVolumes } from './fs-util.ts';
import { PortInspectionError, probeLoopback, readLsofListeningPorts, readListeningPorts } from './listening-ports.ts';

/**
 * Creates one lazy listener snapshot for an allocation attempt; discard the probe before retrying.
 * When the native TCP table cannot be read, each port is checked with an lsof listener scan and
 * loopback connects instead. Rejects with `PortInspectionError` only when none of them can answer.
 */
export function createPortProbe(): (port: number) => Promise<boolean> {
  let snapshot: Promise<ReadonlySet<number> | Error> | undefined;
  let lsof: Promise<ReadonlySet<number> | null> | undefined;
  return async (port) => {
    const listening = await (snapshot ??= readListeningPorts().catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    ));
    if (!(listening instanceof Error)) return !listening.has(port);
    const [listed, ipv4, ipv6] = await Promise.all([
      (lsof ??= readLsofListeningPorts()),
      probeLoopback(port, '127.0.0.1'),
      probeLoopback(port, '::1'),
    ]);
    if (listed?.has(port) || ipv4 === 'taken' || ipv6 === 'taken') return false;
    if (listed || (ipv4 === 'free' && ipv6 === 'free')) return true;
    throw new PortInspectionError(
      `Cannot tell whether TCP port ${port} is free: the TCP listener table failed (${listening.message.replace(/\s+/g, ' ').trim()}), lsof could not list listeners, and a loopback connect failed.`,
    );
  };
}

export function isMetroRunning(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = request({ hostname: 'localhost', port, path: '/status', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data.includes('packager-status:running')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

const FIRST_PORT = 8082;
const PORT_SCAN_LIMIT = 200;

export async function computeNextPort(isFree: (port: number) => Promise<boolean> = createPortProbe()): Promise<number> {
  const taken = new Set(allMetroPorts());
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SCAN_LIMIT; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `Found no free Metro port between ${FIRST_PORT} and ${FIRST_PORT + PORT_SCAN_LIMIT - 1}. ` +
      'Free one up, or stop a stale bundler (`stim status`, `stim stop <port>`).',
  );
}

export interface ReclaimableCandidate {
  port: number;
  ownerPath: string;
}

export async function findReclaimablePort(
  excludeProjectPath: string,
  probe: (port: number) => Promise<boolean> = isMetroRunning,
  {
    isMounted = isOnMountedVolume,
    mountedVolumes,
  }: { isMounted?: (path: string, mountedVolumes?: string[]) => boolean; mountedVolumes?: string[] } = {},
): Promise<ReclaimableCandidate | null> {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  const mounted = mountedVolumes || listMountedVolumes();
  const candidates: ReclaimableCandidate[] = [];
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (path === excludeProjectPath) continue;
    if (Object.keys(proj.ports ?? {}).length) continue;
    if (existsSync(path)) continue;
    if (!isMounted(path, mounted)) continue;
    if (typeof proj.metroPort === 'number') {
      candidates.push({ port: proj.metroPort, ownerPath: path });
    }
  }
  for (const c of candidates) {
    const alive = await probe(c.port);
    if (!alive) return c;
  }
  return null;
}

export async function allocatePort(
  projectPath: string,
  probe: (port: number) => Promise<boolean> = isMetroRunning,
  isFree: (port: number) => Promise<boolean> = createPortProbe(),
): Promise<number> {
  const reclaim = await findReclaimablePort(projectPath, probe);
  if (reclaim && (await isFree(reclaim.port))) {
    releaseMetroPort(reclaim.ownerPath, reclaim.port);
    return reclaim.port;
  }
  return computeNextPort(isFree);
}

const RESERVE_ATTEMPTS = 5;

export async function reserveMetroPort(
  projectPath: string,
  probe: (port: number) => Promise<boolean> = isMetroRunning,
  isFree?: (port: number) => Promise<boolean>,
  pinned: number | null = null,
): Promise<number> {
  if (pinned !== null) {
    if (claimMetroPort(projectPath, pinned) !== null) return pinned;
    throw new Error(`metro.port ${pinned} is already reserved by another workspace's Metro or named port.`);
  }
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const port = await allocatePort(projectPath, probe, isFree);
    const claimed = claimMetroPort(projectPath, port);
    if (claimed !== null) return claimed;
  }
  throw new Error(
    `Could not reserve a Metro port after ${RESERVE_ATTEMPTS} attempts: another Stim run claimed each one first. Retry.`,
  );
}
