import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { createLineReader } from '../../process-output.ts';
import { captureProcessToken } from '../../process-identity.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import type { MetroRunMessage } from '../metro/child-server.ts';
import { drainGroupOutput, stopProcessGroup, writeExitRecord } from '../metro/group-stop.ts';
import { consoleExitFile } from './claim.ts';
import { CONSOLE_RUN_ACCEPT, CONSOLE_STOP_MS, parseDeviceConsoleLine } from './ios-device.ts';

const send = (message: MetroRunMessage) =>
  new Promise<void>((done) => (process.send ? process.send(message, () => done()) : done()));

/**
 * A physical iPhone console's parent: runs `devicectl --console` in its own process group, writes its lines and the
 * collector records to the workspace's `device.ndjson` itself, and once the console has exited and its output has
 * ended writes how it ended to the stream's exit file, then exits.
 * @ref LLP 0018#the-physical-iphone-consoles-helper -- the console's output and exit outlive stimd
 */
async function runConsoleHelper(argv: readonly string[]): Promise<void> {
  const split = argv.indexOf('--');
  const [root, streamId, options] = split < 0 ? [] : argv.slice(0, split);
  const [command, ...args] = split < 0 ? [] : argv.slice(split + 1);
  const parsed: unknown = options ? JSON.parse(options) : null;
  if (!root || !streamId || !command || !isJsonObject(parsed))
    throw new Error('console-run needs a workspace, a stream id, its options and a command.');
  const runId = typeof parsed.runId === 'string' ? parsed.runId : null;
  const bundleId = String(parsed.bundleId);
  const udid = String(parsed.udid);
  const attribution = isJsonObject(parsed.attribution) ? parsed.attribution : {};
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'device.ndjson'), {
    maxBytes: LOG_ROTATE_BYTES,
    fields: { streamId, ...(runId ? { runId } : {}) },
  });
  const record = (level: string, event: string, msg: string) =>
    writer.write({
      ...attribution,
      src: 'device',
      platform: 'ios',
      level,
      event,
      msg,
    });
  let child: ChildProcess;
  try {
    child = getExecutor().spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: process.env,
    });
  } catch (error) {
    await send({
      type: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
    writer.close();
    process.exitCode = 1;
    return;
  }
  try {
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    const spawn: { error: Error | null } = { error: null };
    child.once('error', (error) => (spawn.error = error));
    const processToken = child.pid === undefined ? null : captureProcessToken(child.pid);
    if (child.pid === undefined || !processToken) {
      if (child.pid !== undefined) child.kill('SIGKILL');
      await drainGroupOutput(child, closed, () => false);
      await send({
        type: 'failed',
        message: spawn.error?.message ?? 'the device console started but its process identity could not be read',
      });
      return;
    }
    const leader = { pid: child.pid, processToken };
    record(
      'info',
      'collector_started',
      `device log stream launching ${bundleId} on device ${udid} and streaming its console; subsystem, category and severity are not carried on hardware -- see \`stim guide logs\``,
    );
    let captured = 0;
    const onLine = (line: string) => {
      const parsedLine = parseDeviceConsoleLine(line);
      if (!parsedLine) return;
      captured++;
      writer.write({ ...attribution, ...parsedLine, platform: 'ios' });
    };
    // devicectl --console connects the app's stderr to its own, and the os_log mirror and every crash report arrive
    // there rather than on stdout.
    for (const stream of ['stdout', 'stderr'] as const) {
      const reader = createLineReader(onLine);
      child[stream]?.setEncoding('utf-8');
      child[stream]?.on('data', (chunk) => reader.push(chunk));
      child[stream]?.once('end', () => reader.flush());
    }
    let accepted = false;
    let requested = false;
    let unverified = false;
    let stopping: Promise<void> | null = null;
    const stop = () => {
      requested = true;
      stopping ??= stopProcessGroup(leader, { termMs: CONSOLE_STOP_MS, label: 'device console' }).catch(
        (error: unknown) => {
          unverified = true;
          record(
            'error',
            'collector_stop_unverified',
            `the console helper could not stop devicectl pid ${leader.pid}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    };
    const onMessage = (message: unknown) => {
      if (message !== CONSOLE_RUN_ACCEPT) return;
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
    void send({ type: 'registered', ...leader });
    const ended = await exited;
    await drainGroupOutput(child, closed, () => unverified);
    await stopping;
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (unverified) {
      process.exitCode = 1;
      return;
    }
    if (captured === 0 && !requested)
      record(
        'warn',
        'collector_empty',
        `the device console produced no output for ${bundleId}; devicectl only connects the app's streams when it starts the app, and os_log below the info level never reaches them`,
      );
    const how = ended.signal ? `signal ${ended.signal}` : `exit code ${ended.code}`;
    if (requested) record('info', 'collector_stopped', 'device log stream stopped');
    else if (ended.code)
      record('error', 'collector_failed', `the devicectl console ended with ${how}; treat the run as failed`);
    else record('info', 'collector_stopped', `device log stream ended (${how}); the app or device is gone`);
    writeExitRecord(consoleExitFile(root, streamId), {
      ...leader,
      code: ended.code,
      signal: ended.signal,
      exitedAt: new Date().toISOString(),
      helperPid: process.pid,
    });
  } finally {
    writer.close();
    if (process.connected) process.disconnect?.();
  }
}

if (/[\\/](console-run\.mjs|logs[\\/]console-run\.ts)$/.test(process.argv[1] ?? ''))
  await runConsoleHelper(process.argv.slice(2));
