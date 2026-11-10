import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { readMacosRecord } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { createNdjsonWriter, logLines } from '../ndjson.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
} from '../ownership-claim.ts';
import { inspectProcessIdentity, sameProcessRecord, waitForProcessExit } from '../process-identity.ts';
import { macosLogFile, macosProcess, macosRuntimeClaim, updateMacosRecord } from './state.ts';

export async function runMacosSupervisor(root: string, launchId: string): Promise<void> {
  const record = readMacosRecord(root);
  if (!record || record.launchId !== launchId || record.build.state !== 'ok') {
    throw new Error('The macOS launch record changed before its supervisor started.');
  }
  const owner = macosProcess(process.pid);
  const attempt = tryAcquireClaim({ root: macosRuntimeClaim(root), mode: 'exclusive', label: 'macOS app' });
  if (attempt.pending) releaseClaim(attempt.pending);
  const claim = attempt.acquired;
  if (!claim) throw new Error(`The macOS runtime is already held at ${attempt.held?.path ?? macosRuntimeClaim(root)}.`);
  const writer = createNdjsonWriter(macosLogFile(root), {
    maxBytes: LOG_ROTATE_BYTES,
    ...(record.runId ? { fields: { runId: record.runId } } : {}),
  });
  let app: ReturnType<typeof macosProcess> | undefined;
  let stopping = false;
  let spawned = false;
  let childExited = false;
  let accepted = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!app || inspectProcessIdentity(app) !== 'same') return;
      process.kill(app.pid, signal);
      if (await waitForProcessExit(app, 5000)) return;
    }
  };
  const disconnected = () => {
    if (!accepted) void stop();
  };
  const accept = (message: unknown) => {
    if (message !== 'macos-accept' || stopping) return;
    accepted = true;
    process.send?.('macos-accepted', () => {});
  };
  process.on('disconnect', disconnected);
  try {
    if (
      !record.supervisor ||
      !sameProcessRecord(readMacosRecord(root)?.supervisor, record.supervisor) ||
      !updateMacosRecord(root, record.supervisor, { supervisor: owner })
    ) {
      throw new Error('The macOS launch owner changed.');
    }
    if (stopping || !process.connected) throw new Error('The macOS launcher disconnected before startup.');
    markClaimChildPending(claim);
    const child = getExecutor().spawn(record.executable, record.arguments, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Foundation reads NSUnbufferedIO to flush stdout per write; a piped Swift print() otherwise waits until exit.
      env: { ...process.env, NSUnbufferedIO: 'YES' },
    });
    spawned = child.pid !== undefined;
    const ended = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => {
        childExited = true;
        resolve();
      });
    });
    if (!child.pid) {
      await ended;
      throw new Error('The macOS app did not start.');
    }
    app = macosProcess(child.pid);
    setClaimChild(claim, app);
    if (!updateMacosRecord(root, owner, { app })) {
      if (inspectProcessIdentity(app) === 'same') process.kill(app.pid, 'SIGTERM');
      throw new Error('The macOS launch owner changed.');
    }
    const log = (level: string, msg: string) => writer.write({ src: 'client', platform: 'macos', level, msg });
    if (child.stdout) logLines(child.stdout, (line) => log('info', line));
    if (child.stderr) logLines(child.stderr, (line) => log('warn', line));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('message', accept);
    log('info', `Started ${record.product} (pid ${app.pid}).`);
    // Node reports a closed IPC channel through the send callback instead of an unhandled error.
    process.send?.('macos-registered', () => {});
    await ended;
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    log(
      stopping || child.exitCode === 0 ? 'info' : 'error',
      `Exited ${record.product} (${child.exitCode ?? child.signalCode ?? 'unknown'}).`,
    );
    updateMacosRecord(root, owner, { app: undefined, supervisor: undefined });
  } finally {
    process.off('disconnect', disconnected);
    process.off('message', accept);
    const gone = !spawned || childExited || (app && ['gone', 'different'].includes(inspectProcessIdentity(app)));
    if (gone) {
      clearClaimChild(claim);
      releaseClaim(claim);
    }
    writer.close();
  }
}

if (process.argv[1]?.endsWith('/macos-run.mjs') || process.argv[1]?.endsWith('/macos/run.ts')) {
  const [root, launchId] = process.argv.slice(2);
  if (!root || !launchId) throw new Error('macos-run needs a workspace and launch identity.');
  await runMacosSupervisor(root, launchId);
}
