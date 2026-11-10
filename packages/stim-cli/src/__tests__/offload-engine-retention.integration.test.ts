import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildHost } from '../job/offload/host.ts';
import { buildClaimRoot, keptEntries, readBuildClaims } from '../engine-store/claims.ts';
import { readClaimSet } from '../ownership-claim.ts';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../daemon/engine-switch.ts', async (original) => ({
  ...(await original<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: () => ({ root: fixture.root, build: '0123456789ab' }),
}));

test('a worker that exits without an acknowledgement retains its selected engine claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-offload-engine-'));
  fixture.root = join(root, 'engine');
  const tree = join(fixture.root, '0123456789ab');
  mkdirSync(join(tree, 'dist'), { recursive: true });
  writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
  writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100_000 } }));
  vi.stubEnv('STIM_HOME', home);
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  const host = new BuildHost({ worker, env: process.env });
  const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
  try {
    const job = await host.launch({
      client: 'client',
      repo: 'repo',
      job: { platform: 'ios' },
      session,
      send: () => {},
    });
    if ('error' in job) throw new Error(job.error.message);
    await job.done;
    expect(job.outcome).toMatchObject({ ok: false, code: 'cleanup-unresolved' });
    const claimRoot = buildClaimRoot(fixture.root, '0123456789ab');
    expect(readClaimSet(claimRoot).live).toEqual(
      expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
    );
    expect(keptEntries({ current: null, previous: null, staged: null }, readBuildClaims(fixture.root))).toContain(
      '0123456789ab',
    );
  } finally {
    session.close();
    await host.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
