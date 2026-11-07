import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getExecutor } from '../exec.ts';
import { createStreams } from '../stimd/logs/streams.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

test('unverified initial PID cleanup retains the stream claim and returns its typed failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-query-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-query-root-')));
  vi.stubEnv('STIM_HOME', home);
  const failure = Object.assign(new Error('PID query cleanup unknown'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  vi.spyOn(getExecutor(), 'runFileAsync').mockRejectedValue(failure);
  const messages: string[] = [];
  const streams = createStreams((message) => messages.push(message));
  try {
    const { streamId } = await streams.start(
      { root, platform: 'android', serial: 'emulator-1', packageName: 'com.test' },
      { PATH: process.env.PATH ?? '' },
    );
    await vi.waitFor(() => expect(messages.some((message) => message.includes('did not close'))).toBe(true));
    await expect(streams.stop(root, 'android', 'default', streamId)).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    expect(readWorkspaceState(root)?.collectors?.android).toMatchObject({ streamId });
    const claimRoot = join(
      workspaceDir(root),
      'log-streams',
      `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`,
    );
    expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await streams.close().catch(() => {});
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('unverified backfill PID cleanup retains history and stream claims', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-query-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-query-root-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const adb = join(bin, 'adb');
  writeFileSync(adb, '#!/bin/sh\nexec sleep 600\n');
  chmodSync(adb, 0o755);
  const failure = Object.assign(new Error('backfill PID cleanup unknown'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  let pidCalls = 0;
  let streamId = '';
  let preflightPending = false;
  vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async (_file, args) => {
    if (args.includes('pidof') && ++pidCalls > 1) {
      const historyRoot = join(
        workspaceDir(root),
        'log-backfills',
        `${createHash('sha256').update(streamId).digest('hex')}.claim`,
      );
      preflightPending = readClaimSet(historyRoot).live[0]?.childPending === true;
      throw failure;
    }
    return args.includes('date') ? String(Date.now()) : '3132';
  });
  const env = { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) };
  const streams = createStreams(() => {});
  try {
    ({ streamId } = await streams.start(
      { root, platform: 'android', serial: 'emulator-1', packageName: 'com.test' },
      env,
    ));
    const signal = new AbortController().signal;
    let reply = await streams.wait(root, 'android', 'default', streamId, Date.now() - 1000, 0, 1000, signal, env);
    while (reply.coverage === 'pending')
      reply = await streams.wait(
        root,
        'android',
        'default',
        streamId,
        Date.now() - 1000,
        reply.revision,
        1000,
        signal,
        env,
      );
    expect(reply.coverage).toBe('failed');
    expect(preflightPending).toBe(true);
    await expect(streams.stop(root, 'android', 'default', streamId)).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const streamRoot = join(
      workspaceDir(root),
      'log-streams',
      `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`,
    );
    const historyRoot = join(
      workspaceDir(root),
      'log-backfills',
      `${createHash('sha256').update(streamId).digest('hex')}.claim`,
    );
    expect(readClaimSet(streamRoot).live[0]?.childPending).toBe(true);
    expect(readClaimSet(historyRoot).live[0]?.childPending).toBe(true);
    expect(readWorkspaceState(root)?.collectors?.android).toMatchObject({ streamId });
  } finally {
    vi.restoreAllMocks();
    await streams.close().catch(() => {});
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
