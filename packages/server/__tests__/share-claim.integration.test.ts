import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { holdNativeRun, nativeRunClaimPath } from '../src/share-claim.ts';

const WORKSPACE = '/work/app';

describe("the native-run claim a web share takes for the workspace's device", () => {
  const previous = process.env.STIM_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-share-claim-unit-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  const other = () => {
    const attempt = tryAcquireClaim({
      root: nativeRunClaimPath(WORKSPACE),
      mode: 'exclusive',
      label: 'native-run lock',
      details: { command: 'ios' },
    });
    if (!attempt.acquired) throw new Error('could not take the claim');
    return attempt.acquired;
  };

  it('is recorded as a share, which stim stop waits for instead of signalling', async () => {
    const hold = await holdNativeRun(WORKSPACE, { waitMs: 100, stop: () => false });
    if ('code' in hold) throw new Error(hold.message);
    const [holder] = readClaimSet(nativeRunClaimPath(WORKSPACE)).live;
    expect(holder?.details).toEqual({ command: 'share', purpose: 'web share' });
    hold.release();
    expect(readClaimSet(nativeRunClaimPath(WORKSPACE)).live).toEqual([]);
  });

  it('waits for a holder that finishes within the wait', async () => {
    const run = other();
    setTimeout(() => releaseClaim(run), 150);
    const hold = await holdNativeRun(WORKSPACE, { waitMs: 3000, stop: () => false });
    expect('release' in hold).toBe(true);
    if ('release' in hold) hold.release();
  });

  it('stops waiting when the server is stopping', async () => {
    const run = other();
    const refused = await holdNativeRun(WORKSPACE, { waitMs: 3000, stop: () => true });
    expect(refused).toEqual({ code: 'action-failed', message: 'stim-server is stopping.' });
    releaseClaim(run);
  });
});
