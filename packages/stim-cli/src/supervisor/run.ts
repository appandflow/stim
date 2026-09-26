import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearSupervisor, setSupervisor } from '../workspace/config.ts';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { type NdjsonWriter, createNdjsonWriter } from '../ndjson.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { captureProcessToken } from '../process-identity.ts';
import { detectIsExpo } from '../workspace/project.ts';
import { describeError } from './errors.ts';
import { relaunchWithLogFile } from '../detached-entry.ts';
import { MODE_BARE, MODE_EXPO, clearExpoMetroTunnel, clearWorkspaceSupervisor, writePidFile } from './state.ts';
import {
  clearWorkspaceStateKeys,
  writeWorkspaceState,
  readWorkspaceState,
  withWorkspaceStateLock,
} from '../workspace/workspace-state.ts';
import {
  DEV_SERVER_STOP_REQUEST_KEY,
  IDLE_STOP_KEY,
  readDevServerStopRequest,
  type DevServerStopRecord,
} from '@stim-cli/core/state';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { trackDevServerActivity, watchIdleDevServer, workspaceIdleProbe, type IdleProbe } from './idle-stop.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import {
  describeDevServerStop,
  devServerStopLevel,
  devServerStopRecord,
  vanishedSupervisorMessage,
  type SupervisorExitTrigger,
} from './stop-cause.ts';

export {
  MODE_BARE,
  MODE_EXPO,
  clearExpoMetroTunnel,
  clearWorkspaceSupervisor,
  readPidFile,
  writePidFile,
} from './state.ts';

interface ParsedSupervisorArgs {
  root?: string;
  port?: number;
  tunnel?: boolean;
  resetCache?: boolean;
  idleStopMinutes?: number;
  error?: string;
}

const USAGE = 'Usage: run.js --root <path> --port <n> [--tunnel] [--reset-cache] [--idle-stop-minutes <n>]';

export function parseArgs(argv: string[]): ParsedSupervisorArgs {
  let root: string | undefined;
  let port: string | undefined;
  let tunnel = false;
  let resetCache = false;
  let idleStopMinutes = '0';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      root = argv[++i];
      continue;
    }
    if (arg === '--port') {
      port = argv[++i];
      continue;
    }
    if (arg === '--tunnel') {
      tunnel = true;
      continue;
    }
    if (arg === '--reset-cache') {
      resetCache = true;
      continue;
    }
    if (arg === '--idle-stop-minutes') {
      idleStopMinutes = argv[++i] ?? '';
      continue;
    }
    return { error: `Unknown supervisor argument "${arg}". ${USAGE}` };
  }
  if (!root) return { error: `Missing --root. ${USAGE}` };
  if (!isAbsolute(root)) return { error: `--root must be an absolute path, got "${root}".` };
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    return { error: `--port must be a TCP port number, got "${port}".` };
  }
  if (!/^\d+$/.test(idleStopMinutes)) {
    return { error: `--idle-stop-minutes must be a whole number of minutes, got "${idleStopMinutes}".` };
  }
  return { root: resolve(root), port: parsedPort, tunnel, resetCache, idleStopMinutes: Number(idleStopMinutes) };
}

export interface ServerExitInfo {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
  error?: Error;
}

export interface ServerHandle {
  close(): Promise<void> | void;
  onExit?(cb: (info?: ServerExitInfo | null) => void): void;
  serverPid?: number | null;
}

type ServerStarter = (opts: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  tunnel?: boolean;
  resetCache?: boolean;
  onTunnelUrl?: ((url: string) => void) | null;
}) => Promise<ServerHandle>;

export interface RunSupervisorOptions {
  root: string;
  port: number;
  tunnel?: boolean;
  resetCache?: boolean;
  idleStopMinutes?: number;
  idleProbe?: IdleProbe;
  isExpo?: (projectRoot: string) => boolean;
  startBare?: ServerStarter | null;
  startExpo?: ServerStarter | null;
  now?: () => number;
  onExit?: (code: number) => void;
  attachSignals?: boolean;
  stderr?: (line: string) => void;
}

export async function runSupervisor({
  root,
  port,
  tunnel = false,
  resetCache = false,
  idleStopMinutes = 0,
  idleProbe,
  isExpo = detectIsExpo,
  startBare = null,
  startExpo = null,
  now = Date.now,
  onExit = (code: number) => process.exit(code),
  attachSignals = true,
  stderr = (line: string) => console.error(line),
}: RunSupervisorOptions): Promise<{
  mode: string;
  server: ServerHandle | undefined;
  shutdown: (code: number, event: string, msg: string) => Promise<void>;
  startedAt: string;
} | null> {
  root = realpathSync(root);
  const logsDir = workspaceLogsDir(root);
  const writer = createNdjsonWriter(join(logsDir, 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const mode = isExpo(root) ? MODE_EXPO : MODE_BARE;
  const startedAt = new Date(now()).toISOString();
  const processToken = captureProcessToken(process.pid);
  if (!processToken) {
    stderr('Stim supervisor: could not capture process identity; refusing to start an unmanaged server.');
    writer.close();
    onExit(1);
    return null;
  }
  const record = { pid: process.pid, processToken, port, mode, startedAt };
  const vanished = vanishedSupervisorMessage(readWorkspaceState(root)?.supervisor);
  if (vanished) writer.write({ src: 'metro', level: 'warn', event: 'supervisor_vanished', msg: vanished });

  clearExpoMetroTunnel(root);
  writePidFile(root, process.pid);
  writeWorkspaceState(root, { supervisor: record });
  clearWorkspaceStateKeys(root, [IDLE_STOP_KEY, DEV_SERVER_STOP_REQUEST_KEY]);
  try {
    setSupervisor(root, record);
  } catch (err) {
    writer.write({
      src: 'metro',
      level: 'warn',
      event: 'supervisor_registration_failed',
      msg: `Could not record the supervisor in the global config: ${describeError(err)}`,
    });
    stderr(`Stim supervisor: global registration failed: ${describeError(err)}`);
  }

  writer.write({
    src: 'metro',
    level: 'info',
    event: 'supervisor_started',
    msg: `supervisor pid ${process.pid} starting the ${mode} dev server on port ${port} for ${root}`,
  });

  let stopping = false;
  let stopWatchingIdle: (() => void) | null = null;
  const stopCause = (trigger: SupervisorExitTrigger): DevServerStopRecord => {
    const request = readDevServerStopRequest(readWorkspaceState(root));
    return devServerStopRecord(
      trigger,
      request?.processToken === processToken ? request : null,
      new Date(now()).toISOString(),
    );
  };
  const finish = (code: number, event: string, level: string, msg: string, stop?: DevServerStopRecord) => {
    stopWatchingIdle?.();
    writer.write({ src: 'metro', level, event, msg, ...(stop ? { stop } : {}) });
    try {
      withWorkspaceStateLock(root, () => {
        const current = readWorkspaceState(root)?.supervisor;
        if (current && current.processToken !== processToken) return;
        if (stop) writeWorkspaceState(root, { [IDLE_STOP_KEY]: stop });
        clearWorkspaceStateKeys(root, [DEV_SERVER_STOP_REQUEST_KEY]);
      });
    } catch {}
    try {
      clearSupervisor(root, record);
    } catch {}
    try {
      clearWorkspaceSupervisor(root, record);
    } catch {}
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(
        `Stim supervisor: dropped ${closed.dropped} log record(s); last error: ${describeError(closed.lastError)}`,
      );
    }
    onExit(code);
  };

  let server: ServerHandle | undefined;
  const shutdown = async (code: number, event: string, msg: string, stop?: DevServerStopRecord) => {
    if (stopping || !server) return;
    stopping = true;
    stopWatchingIdle?.();
    try {
      await server.close();
    } catch (err) {
      writer.write({ src: 'metro', level: 'warn', event: 'server_close_failed', msg: describeError(err) });
    }
    finish(code, event, stop ? devServerStopLevel(stop) : code === 0 ? 'info' : 'error', msg, stop);
  };

  if (attachSignals) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        if (server) {
          const stop = stopCause({ kind: 'signal', signal });
          shutdown(
            0,
            'supervisor_stopped',
            `received ${signal}; stopping the ${mode} dev server: ${describeDevServerStop(stop)}`,
            stop,
          );
          return;
        }
        // Node runs signal listeners from the event loop, and startExpoServer spawns and returns
        // without awaiting, so a listener that finds no server runs before any child exists.
        if (stopping) return;
        stopping = true;
        const stop = stopCause({ kind: 'signal', signal });
        finish(
          signal === 'SIGINT' ? 130 : 143,
          'supervisor_stopped',
          'warn',
          `received ${signal} before the ${mode} dev server started; stopping: ${describeDevServerStop(stop)}`,
          stop,
        );
      });
    }
  }

  const serverActivity = trackDevServerActivity(now);
  const serverWriter: NdjsonWriter = Object.assign(Object.create(writer) as NdjsonWriter, {
    write(entry: unknown) {
      serverActivity.record(entry);
      return writer.write(entry);
    },
  });

  try {
    const start: ServerStarter =
      mode === MODE_EXPO
        ? startExpo || (await import('./server-expo.ts')).startExpoServer
        : startBare || (await import('./server-bare.ts')).startBareServer;
    server = await start({
      root,
      port,
      logsDir,
      writer: serverWriter,
      tunnel,
      resetCache,
      onTunnelUrl: (url: string) => {
        try {
          withWorkspaceStateLock(root, () => {
            if (readWorkspaceState(root)?.supervisor?.processToken === processToken) {
              writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url } });
            }
          });
        } catch (err) {
          stderr(`Stim supervisor: could not record the Expo tunnel URL: ${describeError(err)}`);
        }
        writer.write({ src: 'metro', level: 'info', event: 'expo_tunnel_ready', msg: `Expo tunnel ready: ${url}` });
      },
    });
  } catch (err) {
    if (stopping) return null;
    stderr(`Stim supervisor: failed to start the ${mode} dev server: ${describeError(err)}`);
    finish(1, 'supervisor_failed', 'fatal', `failed to start the ${mode} dev server: ${describeError(err)}`);
    return null;
  }

  if (stopping) {
    try {
      await server.close();
    } catch {}
    return null;
  }

  const serverPid = server.serverPid;
  if (serverPid) {
    const serverProcessToken = captureProcessToken(serverPid);
    withWorkspaceStateLock(root, () => {
      if (readWorkspaceState(root)?.supervisor?.processToken === processToken) {
        writeWorkspaceState(root, {
          supervisor: { ...record, serverPid, ...(serverProcessToken ? { serverProcessToken } : {}) },
        });
      }
    });
  }
  writer.write({
    src: 'metro',
    level: 'info',
    event: 'server_started',
    msg: `${mode} dev server listening on port ${port}`,
  });

  if (idleStopMinutes > 0) {
    stopWatchingIdle = watchIdleDevServer({
      idleStopMs: idleStopMinutes * 60_000,
      now,
      serverActivityAt: serverActivity.lastActivityAt,
      probe: idleProbe ?? workspaceIdleProbe(root),
      onIdle: async (idleMinutesNow) => {
        const stopIfStillIdle = async () => {
          const idleMinutes = idleMinutesNow();
          if (stopping || idleMinutes === null) return;
          withWorkspaceStateLock(root, () => {
            if (readWorkspaceState(root)?.supervisor?.processToken === processToken) {
              writeWorkspaceState(root, {
                [IDLE_STOP_KEY]: { reason: 'idle', at: new Date(now()).toISOString(), idleMinutes },
              });
            }
          });
          await shutdown(
            0,
            'supervisor_idle_stopped',
            `no bundle request, client log or Stim command for ${idleMinutes} minutes (metro.idleStopMinutes is ${idleStopMinutes}); stopped the ${mode} dev server`,
          );
        };
        try {
          await withIdleWorkspace(
            root,
            () =>
              withWorkspaceProcessLock(dirname(logsDir), 'metro-start', stopIfStillIdle, {
                external: true,
                waitMs: 0,
                ownerPurpose: 'idle stop',
              }),
            { purpose: 'idle stop', supervisor: false, managedLocks: false },
          );
        } catch (err) {
          stderr(`Stim supervisor: could not stop the idle dev server: ${describeError(err)}`);
        }
      },
    });
  }

  server.onExit?.((info) => {
    if (stopping) return;
    const stop = stopCause({ kind: 'server-exit', mode, code: info?.code ?? null, signal: info?.signal ?? null });
    shutdown(
      stop.reason === 'requested' ? 0 : 1,
      'supervisor_stopped',
      stop.reason === 'requested'
        ? `the ${mode} dev server exited; ${describeDevServerStop(stop)}`
        : `${describeDevServerStop(stop)}; shutting the supervisor down`,
      stop,
    );
  });

  return { mode, server, shutdown, startedAt };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (relaunchWithLogFile(argv)) return;
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`Stim supervisor: ${parsed.error}`);
    process.exit(2);
    return;
  }
  const root = parsed.root as string;
  if (!existsSync(root)) {
    console.error(`Stim supervisor: --root ${root} does not exist.`);
    process.exit(2);
    return;
  }
  try {
    process.chdir(root);
  } catch {}
  process.title = 'stim-supervisor';
  await runSupervisor({
    root,
    port: parsed.port as number,
    tunnel: parsed.tunnel ?? false,
    resetCache: parsed.resetCache ?? false,
    idleStopMinutes: parsed.idleStopMinutes ?? 0,
  });
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(`Stim supervisor: ${describeError(err)}`);
    process.exit(1);
  });
}
