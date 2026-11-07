import { getExecutor } from '../exec.ts';

const state = vi.hoisted(() => ({ pending: false, released: false }));
vi.mock('../ownership-claim.ts', async (load) => {
  const actual = await load<typeof import('../ownership-claim.ts')>();
  return {
    ...actual,
    readClaimSet: (root: string) => ({
      live: root.includes('log-backfills')
        ? []
        : [
            {
              path: '/claim/holder',
              mode: 'shared',
              claimId: 'id',
              owner: { pid: 10, processToken: 'owner' },
              child: { pid: 11, processToken: 'child' },
              details: { streamId: 'stream' },
            },
          ],
      dead: [],
      unresolved: [],
    }),
    markClaimChildPending: () => {
      state.pending = true;
    },
    releaseClaim: () => {
      state.released = true;
      return true;
    },
  };
});
vi.mock('../process-identity.ts', async (load) => {
  const actual = await load<typeof import('../process-identity.ts')>();
  return { ...actual, inspectProcessIdentity: (record: { pid: number }) => (record.pid === 10 ? 'gone' : 'same') };
});

test('failed Windows orphan tree stop retains the pending claim and stream record', async () => {
  const { clearStreamClaim } = await import('../stimd/logs/claim.ts');
  const realProcess = process;
  const beforeRelease = vi.fn<() => void>();
  const run = vi.spyOn(getExecutor(), 'runFileAsync').mockRejectedValue(new Error('taskkill failed'));
  try {
    vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
    await expect(clearStreamClaim('/workspace', 'stream', beforeRelease)).rejects.toThrow('taskkill failed');
    expect(state.pending).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(beforeRelease).not.toHaveBeenCalled();
    expect(state.released).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
