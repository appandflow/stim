import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
