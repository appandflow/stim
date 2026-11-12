import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildHost } from '../job/offload/host.ts';
import { FINGERPRINT_SCHEMA, fingerprintInputsRow } from '../fingerprint/key.ts';

const fixture = vi.hoisted((): { root: string; release: (() => void) | undefined } => ({
  root: '',
  release: undefined,
}));

vi.mock('../daemon/engine-switch.ts', async (original) => ({
  ...(await original<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: () => ({ root: fixture.root, build: '0123456789ab' }),
}));

vi.mock('../engine-store/locks.ts', async (original) => ({
  ...(await original<typeof import('../engine-store/locks.ts')>()),
  takeLock: () =>
    new Promise((resolve) => {
      fixture.release = () => resolve({ release: async () => {} });
    }),
}));

test('closing the session while engine admission waits never starts a worker', async () => {
  fixture.root = mkdtempSync(join(tmpdir(), 'stim-offload-admission-'));
  const host = new BuildHost({ worker: 'unused', env: process.env });
  const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
  try {
    const pending = host.launch({ client: 'client', repo: 'repo', job: {}, session, send: () => {} });
    expect(fixture.release).toBeDefined();
    session.close();
    if (!fixture.release) throw new Error('The fixture did not enter the store lock.');
    fixture.release();
    expect(await pending).toMatchObject({ error: { code: 'build-refused' } });
    expect(host.running()).toBe(0);
  } finally {
    session.close();
    await host.close();
    rmSync(fixture.root, { recursive: true, force: true });
    fixture.release = undefined;
  }
});

test('build.start refuses a drive path in tagged fingerprint environment before admission', async () => {
  const host = new BuildHost({ worker: 'unused', env: process.env });
  const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
  const launch = vi.spyOn(host, 'launch').mockResolvedValue({ error: { code: 'build-refused', message: 'admitted' } });
  try {
    session.sync({ repo: 'repo', files: [], done: true });
    const base = {
      repo: 'repo',
      project: '',
      platform: 'ios',
      runtime: 'iOS-27-0',
      stimBuild: 'b1',
      compat: 6,
      fingerprint: 'a'.repeat(64),
      fingerprintSources: [],
      fingerprintSchema: FINGERPRINT_SCHEMA,
      fingerprintNative: 'tracked',
      fingerprintLayout: { projectPath: null, gradleRoot: null, module: null },
      fingerprintRuntime: { node: '22.22', evaluator: '0'.repeat(64), packages: {} },
    };
    for (const path of ['C:\\secret', 'C:secret', '\\\\server\\share']) {
      expect(
        await session.start({ ...base, fingerprintEnv: { set: { ASSET_DIR: { path } }, absent: [] } }),
      ).toMatchObject({ error: { code: 'bad-request', message: expect.stringContaining('fingerprint replay') } });
    }
    expect(launch).not.toHaveBeenCalled();
    for (const path of ['assets', '<install>/'])
      expect(
        await session.start({ ...base, fingerprintEnv: { set: { ASSET_DIR: { path } }, absent: [] } }),
      ).toMatchObject({ error: { code: 'build-refused', message: 'admitted' } });
    expect(launch).toHaveBeenCalledTimes(2);
  } finally {
    launch.mockRestore();
    session.close();
    await host.close();
  }
});

test('build.start admits declared fingerprint inputs only when they match the keyed row and stay in the repository', async () => {
  const host = new BuildHost({ worker: 'unused', env: process.env });
  const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
  const launch = vi.spyOn(host, 'launch').mockResolvedValue({ error: { code: 'build-refused', message: 'admitted' } });
  const start = (paths: string[] | undefined, keyed: string[] = paths ?? ['native-extra']) => {
    const row = fingerprintInputsRow(keyed);
    return session.start({
      repo: 'repo',
      project: 'apps/app',
      platform: 'ios',
      runtime: 'iOS-27-0',
      stimBuild: 'b1',
      compat: 6,
      fingerprint: 'a'.repeat(64),
      fingerprintSources: [{ id: row.name, kind: row.kind, hash: row.hash }],
      fingerprintSchema: FINGERPRINT_SCHEMA,
      fingerprintEnv: { set: {}, absent: [] },
      fingerprintNative: 'tracked',
      fingerprintLayout: { projectPath: null, gradleRoot: null, module: null },
      fingerprintRuntime: { node: '22.22', evaluator: '0'.repeat(64), packages: {} },
      ...(paths ? { fingerprintInputs: paths } : {}),
    });
  };
  try {
    session.sync({ repo: 'repo', files: [], done: true });
    for (const refused of [start(undefined), start(['other'], ['native-extra']), start(['../../../outside'])])
      expect(await refused).toMatchObject({
        error: { code: 'bad-request', message: expect.stringContaining('fingerprint replay') },
      });
    expect(launch).not.toHaveBeenCalled();
    expect(await start(['../../packages/shared', 'native-extra'])).toMatchObject({
      error: { code: 'build-refused', message: 'admitted' },
    });
  } finally {
    launch.mockRestore();
    session.close();
    await host.close();
  }
});

test('build.start admits an Exact build, keyed by its synced manifest, without a fingerprint replay description', async () => {
  const host = new BuildHost({ worker: 'unused', env: process.env });
  const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
  const launch = vi.spyOn(host, 'launch').mockResolvedValue({ error: { code: 'build-refused', message: 'admitted' } });
  try {
    session.sync({ repo: 'repo', files: [], done: true });
    expect(
      await session.start({
        repo: 'repo',
        project: '',
        platform: 'ios',
        runtime: 'iOS-27-0',
        stimBuild: 'b1',
        compat: 6,
        fingerprint: 'a'.repeat(64),
        exact: { name: 'shop-app', exact2: 'b'.repeat(40), bun: '1.4.2', rust: '1.97.0', env: {} },
      }),
    ).toMatchObject({ error: { code: 'build-refused', message: 'admitted' } });
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
    session.close();
    await host.close();
  }
});
