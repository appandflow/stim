import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { getExecutor } from './exec.ts';

/**
 * Returns occupied TCP ports across local interfaces. Rejects if listener inspection fails.
 */
export async function readListeningPorts(platform: NodeJS.Platform = process.platform): Promise<ReadonlySet<number>> {
  switch (platform) {
    case 'darwin':
      return parseDarwinPorts(await readNetstat('/usr/sbin/netstat', ['-anL', '-p', 'tcp']));
    case 'linux': {
      const tables = await Promise.all([
        readFile('/proc/net/tcp', 'utf8'),
        readFile('/proc/net/tcp6', 'utf8').catch((error) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }),
      ]);
      return parseLinuxPorts(tables);
    }
    case 'win32':
      return parseWindowsPorts(await readNetstat('netstat', ['-an']));
    default:
      throw new Error(`TCP listener inspection is not supported on ${platform}.`);
  }
}

const DARWIN_TITLE = 'Current listen queue sizes (qlen/incqlen/maxqlen)';
const DARWIN_COLUMNS = /^Listen\s+Local Address$/;
const DARWIN_TABLE_CHANGE = /^Some tcp sockets may have been (?:created|deleted|created or deleted)\.?$/;
const DARWIN_LISTENER = /^\d+\/\d+\/\d+\s+\S+\.(?<port>\d+)$/;

function parseDarwinPorts(output: string): Set<number> {
  const ports = new Set<number>();
  let title = false;
  let columns = false;

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line === DARWIN_TITLE) title = true;
    else if (DARWIN_COLUMNS.test(line)) columns = true;
    if (!line || line === DARWIN_TITLE || DARWIN_COLUMNS.test(line) || DARWIN_TABLE_CHANGE.test(line)) continue;

    const listener = DARWIN_LISTENER.exec(line)?.groups;
    if (!listener) throw new Error('Cannot parse the TCP listen table from netstat.');

    addPort(ports, Number(listener.port));
  }

  if (!title || !columns) throw new Error('netstat printed no TCP listen table.');
  return ports;
}

const LINUX_COLUMNS = /^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\s/;
const LINUX_TCP_STATE = /^[0-9A-F]{2}$/i;
const LINUX_LOCAL_ADDRESS = /^(?:[0-9A-F]{8}|[0-9A-F]{32}):(?<port>[0-9A-F]{4})$/i;
const LINUX_LISTEN_STATE = '0A';

function parseLinuxPorts(tables: readonly (string | null)[]): Set<number> {
  const ports = new Set<number>();

  for (const table of tables) {
    if (table === null) continue;

    const [header, ...rows] = table.trim().split('\n');
    if (!header || !LINUX_COLUMNS.test(header)) throw new Error('Cannot parse the TCP socket table from /proc/net.');

    for (const raw of rows) {
      const line = raw.trim();
      if (!line) continue;

      const [, localAddress, , state] = line.split(/\s+/);

      if (!state || !LINUX_TCP_STATE.test(state)) throw new Error('Invalid TCP state in /proc/net.');
      if (state.toUpperCase() !== LINUX_LISTEN_STATE) continue;

      const listener = localAddress && LINUX_LOCAL_ADDRESS.exec(localAddress)?.groups;
      if (!listener) throw new Error('Invalid TCP listener in /proc/net.');

      addPort(ports, Number(`0x${listener.port}`));
    }
  }

  return ports;
}

const WINDOWS_COLUMNS = /^Proto\s/;
const WINDOWS_TCP_ROW = /^TCP\s+\S*:(?<localPort>\d+)\s+\S*:(?<remotePort>\d+)\s+\S/;

function parseWindowsPorts(output: string): Set<number> {
  const ports = new Set<number>();
  let table = false;

  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (WINDOWS_COLUMNS.test(line)) table = true;
    const [protocol] = line.split(/\s+/, 1);
    if (protocol !== 'TCP') continue;
    table = true;

    const connection = WINDOWS_TCP_ROW.exec(line)?.groups;
    if (!connection) throw new Error('Cannot parse the TCP connection table from netstat.');

    // Windows localizes the state column; listeners have no remote port.
    if (Number(connection.remotePort) === 0) addPort(ports, Number(connection.localPort));
  }

  if (!table) throw new Error('netstat printed no TCP connection table.');
  return ports;
}

function readNetstat(file: string, args: string[]): Promise<string> {
  return getExecutor().runFileAsync(file, args, {
    timeoutMs: 5000,
    rejectStderr: true,
    env: { LC_ALL: 'C' },
  });
}

function addPort(ports: Set<number>, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TCP listener port.');
  ports.add(port);
}

export function addressPort(address: string | undefined): number {
  const colon = String(address ?? '').lastIndexOf(':');
  return colon < 0 ? Number.NaN : Number(String(address).slice(colon + 1));
}

export function parseLsofListeners(out: unknown): Map<number, number[]> {
  const byPort = new Map<number, number[]>();
  let pid: number | null = null;
  for (const line of String(out ?? '').split('\n')) {
    if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && pid !== null && Number.isFinite(pid)) {
      const port = addressPort(line.slice(1));
      const pids = byPort.get(port) ?? [];
      if (!pids.includes(pid)) pids.push(pid);
      byPort.set(port, pids);
    }
  }
  return byPort;
}

export const PORT_INSPECTION_REMEDY =
  'Allow Stim to run netstat or lsof, or to connect to 127.0.0.1 and ::1, then retry. A metro.port pin skips the scan for Metro.';

export class PortInspectionError extends Error {
  readonly code = 'STIM_PORT_INSPECTION_FAILED';
  readonly reason: string;

  constructor(reason: string) {
    super(`${reason} ${PORT_INSPECTION_REMEDY}`);
    this.reason = reason;
  }
}

/**
 * Returns the TCP ports lsof lists as listening, or null when lsof cannot list them.
 */
export async function readLsofListeningPorts(): Promise<ReadonlySet<number> | null> {
  try {
    const out = await getExecutor().runFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeoutMs: 5000 });
    return new Set([...parseLsofListeners(out).keys()].filter(Number.isInteger));
  } catch (error) {
    const result = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    if (result.status === 1 && !String(result.stdout ?? '').trim() && !String(result.stderr ?? '').trim()) {
      return new Set();
    }
    return null;
  }
}

const IPV6_UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH']);

/**
 * Connects to a loopback port: `taken` when something accepts or the connect hangs, `free` when
 * it is refused or IPv6 is unavailable, `unknown` for any other connect error.
 */
export function probeLoopback(
  port: number,
  host: '127.0.0.1' | '::1',
  timeoutMs = 400,
): Promise<'free' | 'taken' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (answer: 'free' | 'taken' | 'unknown') => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('taken'));
    socket.once('timeout', () => done('taken'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const refused = error.code === 'ECONNREFUSED' || (host === '::1' && IPV6_UNAVAILABLE.has(error.code ?? ''));
      done(refused ? 'free' : 'unknown');
    });
  });
}
