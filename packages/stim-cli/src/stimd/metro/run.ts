import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { processGroupAlive } from '@stim-cli/core/ownership-claim';
import { metroExitFile, type MetroExitRecord } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { signalProcessTree } from '../../metro.ts';
import { createNdjsonWriter, type NdjsonRecord } from '../../ndjson.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { readWorkspaceState, withWorkspaceStateLock, writeWorkspaceState } from '../../workspace/workspace-state.ts';
import { METRO_RUN_ACCEPT, superviseChildServer, type MetroRunMessage } from './child-server.ts';
import { outputRecord } from './output-records.ts';
import { parseExpoWaitingOnUrl } from './server-expo.ts';

const GROUPS = process.platform !== 'win32';
const STOP_MS = 5000;
const DRAIN_MS = 1000;
const STREAMS = ['stdout', 'stderr'] as const;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const send = (message: MetroRunMessage) =>
  new Promise<void>((done) => (process.send ? process.send(message, () => done()) : done()));

/**
 * Waits until the dev server's process group is gone (at once on Windows, which has none) and its stdout and stderr
 * close. Once the group is gone it waits at most `DRAIN_MS` more for the pipes, then stops reading, so a descendant
 * outside the group that still holds a pipe cannot keep the helper alive; that descendant gets EPIPE on its next write.
 */
async function drain(child: ChildProcess, closed: Promise<void>, stuck: () => boolean): Promise<void> {
  const pipes = { closed: false };
  void closed.then(() => (pipes.closed = true));
  const groupAlive = () => GROUPS && child.pid !== undefined && processGroupAlive(child.pid);
  while (!stuck() && groupAlive()) await sleep(100);
  if (!pipes.closed) await Promise.race([closed, sleep(DRAIN_MS)]);
  if (pipes.closed) return;
  for (const stream of STREAMS) child[stream]?.destroy();
  await Promise.race([closed, sleep(DRAIN_MS)]);
}

/**
 * The dev server's parent: runs `command` with `args` from `root` in its own process group with piped output, copies
 * that output into `metro.stdout.log`, `metro.stderr.log` and `metro.ndjson`, and once the dev server has exited and
 * its output has ended writes how it ended to `metro-run.exit.json`, then exits.
 * @ref LLP 0018#the-dev-servers-helper -- the dev server's exit code and output outlive stimd
 */
async function runMetroHelper(argv: readonly string[]): Promise<void> {
  const split = argv.indexOf('--');
  const [root, mode, ...flags] = split < 0 ? [] : argv.slice(0, split);
  const [command, ...args] = split < 0 ? [] : argv.slice(split + 1);
  if (!root || !mode || !command) throw new Error('metro-run needs a workspace, a mode and a command.');
  const logsDir = workspaceLogsDir(root);
  const digest = process.env.STIM_INJECTED_DIGEST;
  const writer = createNdjsonWriter(join(logsDir, 'metro.ndjson'), {
    maxBytes: LOG_ROTATE_BYTES,
    fields: digest ? { inj: digest } : {},
  });
  const raw = { stdout: -1, stderr: -1 };
  let child: ChildProcess;
  try {
    raw.stdout = openSync(join(logsDir, 'metro.stdout.log'), 'w', 0o600);
    raw.stderr = openSync(join(logsDir, 'metro.stderr.log'), 'w', 0o600);
    child = getExecutor().spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: GROUPS,
      env: process.env,
    });
  } catch (error) {
    await send({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
    writer.close();
    for (const stream of STREAMS) if (raw[stream] >= 0) closeSync(raw[stream]);
    process.exitCode = 1;
    return;
  }
  let server: { pid: number; processToken: string } | null = null;
  let accepted = false;
  let unverified = false;
  let stopping: Promise<void> | null = null;
  try {
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    let tunnelSeen = false;
    const onTunnel = (record: NdjsonRecord) => {
      const url = tunnelSeen || typeof record.msg !== 'string' ? null : parseExpoWaitingOnUrl(record.msg);
      if (!url || !server) return;
      tunnelSeen = true;
      const token = server.processToken;
      try {
        withWorkspaceStateLock(root, () => {
          if (readWorkspaceState(root)?.supervisor?.processToken === token)
            writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url } });
        });
      } catch {}
      writer.write({ src: 'metro', level: 'info', event: 'expo_tunnel_ready', msg: `Expo tunnel ready: ${url}` });
    };
    const handle = superviseChildServer({
      mode,
      child,
      log: writer,
      toRecord: outputRecord(mode),
      signal: (sig) => {
        if (child.pid === undefined) return false;
        try {
          return signalProcessTree(child.pid, sig, { group: GROUPS });
        } catch {
          return false;
        }
      },
      alive: GROUPS ? () => child.pid !== undefined && processGroupAlive(child.pid) : null,
      killTimeoutMs: STOP_MS,
      onRecord: flags.includes('--tunnel') ? onTunnel : null,
    });
    for (const stream of STREAMS)
      child[stream]?.on('data', (chunk: string) => {
        try {
          writeSync(raw[stream], chunk);
        } catch {}
      });
    const exited = new Promise<{ code: number | null; signal: string | null; error?: Error } | null>((done) =>
      handle.onExit(done),
    );
    if (child.pid === undefined || !handle.processToken) {
      if (child.pid !== undefined) child.kill('SIGKILL');
      const ended = await exited;
      await drain(child, closed, () => false);
      await send({
        type: 'failed',
        message: ended?.error?.message ?? 'the dev server started but its process identity could not be read',
      });
      return;
    }
    server = { pid: child.pid, processToken: handle.processToken };
    const failure = new AbortController();
    const stopFailed = new Promise<null>((done) =>
      failure.signal.addEventListener('abort', () => done(null), { once: true }),
    );
    const stop = () => {
      stopping ??= handle.close().catch((error: unknown) => {
        unverified = true;
        failure.abort();
        writer.write({
          src: 'metro',
          level: 'error',
          event: 'dev_server_stop_unverified',
          msg: `the dev-server helper could not stop pid ${server?.pid}: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    };
    const onMessage = (message: unknown) => {
      if (message !== METRO_RUN_ACCEPT) return;
      accepted = true;
      process.disconnect?.();
    };
    const onDisconnect = () => {
      if (!accepted) stop();
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    void send({ type: 'registered', ...server });
    const ended = await Promise.race([exited, stopFailed]);
    await drain(child, closed, () => unverified);
    await stopping;
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (unverified) {
      process.exitCode = 1;
      return;
    }
    const exit: MetroExitRecord = {
      ...server,
      code: ended?.code ?? null,
      signal: ended?.signal ?? null,
      exitedAt: new Date().toISOString(),
      helperPid: process.pid,
    };
    const file = metroExitFile(root);
    const staging = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify(exit), { mode: 0o600 });
      renameSync(staging, file);
    } catch (error) {
      rmSync(staging, { force: true });
      throw error;
    }
  } finally {
    writer.close();
    for (const stream of STREAMS) closeSync(raw[stream]);
    if (process.connected) process.disconnect?.();
  }
}

if (/[\\/](metro-run\.mjs|metro[\\/]run\.ts)$/.test(process.argv[1] ?? '')) await runMetroHelper(process.argv.slice(2));
