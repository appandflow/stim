import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildHost } from '../job/offload/host.ts';
import { readClaimSet } from '../ownership-claim.ts';

test.skipIf(process.platform === 'win32')(
  'build.start passes tagged environment to the real worker and rejects a mismatched evaluator before compilation',
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-worker-entry-')));
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ server: { maxLoadPerCore: 100_000 }, concurrency: { maxBuilds: 0 } }),
    );
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('STIM_ACCESS_TICKET', 'worker-access-secret');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const observed = join(root, 'worker-env');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const node = join(bin, 'node');
    writeFileSync(
      node,
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$ASSET_DIR" "$LITERAL" "\${STIM_ACCESS_TICKET-unset}" > ${quote(observed)}\nexec ${quote(process.execPath)} "$@"\n`,
    );
    chmodSync(node, 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
    const host = new BuildHost({
      worker: cli,
      workerArgs: ['__job', 'offload-worker'],
      env: process.env,
      limits: { minFreeBytes: 0 },
    });
    let finish!: (outcome: unknown) => void;
    const outcome = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const events: unknown[] = [];
    const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, (event) => {
      events.push(event);
      if ('outcome' in event) finish(event.outcome);
    });
    let testFailure: { error: unknown } | null = null;
    try {
      const contents = Buffer.from('{"name":"worker-fixture"}');
      const hash = createHash('sha256').update(contents).digest('hex');
      expect(
        session.sync({
          repo: 'repo',
          files: [{ path: 'package.json', kind: 'file', size: contents.length, sha256: hash }],
          done: true,
        }),
      ).toMatchObject({ result: { missing: [hash] } });
      expect(session.blob(Buffer.concat([Buffer.from(hash, 'hex'), contents]))).toBeNull();
      expect(
        await session.start({
          repo: 'repo',
          project: '',
          platform: 'ios',
          runtime: 'iOS-27-0',
          stimBuild: 'fixture',
          compat: 6,
          fingerprint: 'a'.repeat(64),
          fingerprintSources: [],
          fingerprintSchema: 2,
          fingerprintEnv: { set: { ASSET_DIR: { path: 'assets' }, LITERAL: 'npm:literal' }, absent: [] },
          fingerprintNative: 'tracked',
          fingerprintLayout: { projectPath: null, gradleRoot: null, module: null },
          fingerprintRuntime: { node: '22.22', evaluator: '0'.repeat(64), packages: {} },
        }),
      ).toHaveProperty('result.job');
      const result = await Promise.race([
        outcome,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('worker did not finish')), 20_000).unref();
        }),
      ]);
      expect(result).toMatchObject({ ok: false, code: 'fingerprint-runtime' });
      expect(JSON.stringify(result)).not.toContain('worker-access-secret');
      expect(JSON.stringify(events)).not.toContain('worker-access-secret');
      const [path, literal, ticket] = readFileSync(observed, 'utf8').trimEnd().split('\n');
      expect(path).toBe(join(home, 'build-worker', 'client', 'repos', 'repo', 'src', 'assets'));
      expect(literal).toBe('npm:literal');
      expect(ticket).toBe('unset');
    } catch (error) {
      testFailure = { error };
    }
    let cleanupFailure: { error: unknown } | null = null;
    try {
      session.close();
      await host.close();
      const claims = readClaimSet(join(host.clientDir('client'), 'repos', 'repo.claims'));
      if (claims.live.length || claims.unresolved.length) {
        throw new Error('The worker repository claim remains after shutdown.');
      }
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error(`Unverified worker cleanup; retained ${root}`);
      cleanupFailure = { error };
    } finally {
      vi.unstubAllEnvs();
    }
    if (cleanupFailure) throw cleanupFailure.error;
    if (testFailure) throw testFailure.error;
  },
);
