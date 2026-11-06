import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { fingerprint, type Fingerprint } from '../fingerprint/evaluate.ts';
import {
  checkRead,
  indexDir,
  newRecord,
  nowNs,
  recordFiles,
  takeRead,
  writeRecord,
} from '../fingerprint/index-store.ts';
import { fingerprintNotes } from '../fingerprint/doctor.ts';
import { isUncertain } from '../fingerprint/key.ts';
import { precomputePass } from '../fingerprint/precompute.ts';
import {
  disagreementCount,
  localStoreGate,
  remoteStoreGate,
  takeDisagreements,
  verifyHit,
  verifyPending,
} from '../fingerprint/verify.ts';

const MOBILE_MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const REPO_LOCK = join(MOBILE_MODULES, '..', '..', '..', 'pnpm-lock.yaml');
const SLOW = { timeout: 120_000 };
const LATER = 10_000_000_000n;

let base: string;
let spawned: string[][] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-index-')));
  process.env.STIM_HOME = join(base, 'home');
  spawned = [];
  const real = getExecutor();
  setExecutor({
    ...real,
    spawn: (file: string, args: string[], options: object) => {
      spawned.push([file, ...args]);
      return real.spawn(file, args, options);
    },
  });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A CNG Expo app installing nothing of its own: its node_modules is apps/mobile's, with this repository's lockfile. */
function expoApp(dir: string, files: Record<string, string> = {}): string {
  const root = join(base, dir);
  write(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fp-app', version: '1.0.0', dependencies: { expo: '*', 'expo-constants': '*' } }),
  );
  write(join(root, 'pnpm-lock.yaml'), readFileSync(REPO_LOCK, 'utf8'));
  write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp' } }));
  write(
    join(root, 'app.config.js'),
    'module.exports = ({ config }) => ({ ...config, extra: { flag: process.env.APP_FLAG ?? null } });\n',
  );
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  const installed = new Date(Date.now() - 86_400_000);
  utimesSync(join(root, 'pnpm-lock.yaml'), installed, installed);
  symlinkSync(MOBILE_MODULES, join(root, 'node_modules'));
  return realpathSync(root);
}

/** The racy guard trusts only files written more than 50 ms before a computation starts. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, ...extra });
const request = (root: string) => ({ root, target: { platform: 'ios' as const }, embedMode: 'development' as const });

async function key(root: string, index: 'use' | 'skip' = 'use', extra: NodeJS.ProcessEnv = {}): Promise<Fingerprint> {
  const result = await fingerprint(root, { platform: 'ios' }, { env: env(extra), embedMode: 'development', index });
  if (isUncertain(result)) throw new Error(JSON.stringify(result));
  return result;
}

/** Which evaluator children ran since the last call: `config`, `resolve`, `react-native-config`, `embed`. */
function ran(): string[] {
  const parts = spawned.map((argv) =>
    argv.includes('resolve')
      ? 'resolve'
      : argv.includes('react-native-config')
        ? 'react-native-config'
        : argv.includes('embed')
          ? 'embed'
          : argv.includes('expo')
            ? 'config'
            : argv.join(' '),
  );
  spawned = [];
  return parts.toSorted();
}

const indexOf = (root: string) => indexDir('ios', root, { projectPath: 'ios', gradleRoot: null, module: null });

/** Makes the newest record serve an app config other than the one the tree evaluates to, as a tracer gap would. */
function corruptRecord(root: string): void {
  const [file = ''] = recordFiles(indexOf(root));
  const text = readFileSync(file, 'utf8');
  if (!text.includes('"name":"fp"')) throw new Error('no config part recorded');
  writeFileSync(file, text.replaceAll('"name":"fp"', '"name":"stale"'));
}

describe('recorded reads', () => {
  const roots = () => ({ project: base, install: base });

  test('a file written during the computation or gone since is not recorded, and one written before it is', () => {
    const file = join(base, 'a.txt');
    write(file, 'one');
    expect(takeRead(file, 'file', roots(), nowNs())).toBeNull();
    expect(takeRead(file, 'file', roots(), nowNs() + LATER)).toMatchObject({ kind: 'file', path: 'p:a.txt' });
    rmSync(file);
    expect(takeRead(file, 'file', roots(), nowNs() + LATER)).toBeNull();
  });

  test('a rewrite with the old mtime fails by ctime, and a same-bytes replacement holds by content only', () => {
    const file = join(base, 'a.txt');
    write(file, 'one');
    const read = takeRead(file, 'file', roots(), nowNs() + LATER);
    if (!read) throw new Error('not recorded');
    expect(checkRead(read, roots())).toBe('stat');
    const { atime, mtime } = statSync(file);
    writeFileSync(file, 'two');
    utimesSync(file, atime, mtime);
    expect(checkRead(read, roots())).toBe(false);
    write(join(base, 'b.txt'), 'one');
    utimesSync(join(base, 'b.txt'), atime, mtime);
    renameSync(join(base, 'b.txt'), file);
    expect(checkRead(read, roots())).toBe('content');
  });

  test('an index directory keeps its 8 newest records', () => {
    const dir = join(base, 'index');
    const record = newRecord({ evaluator: 'e', runtime: 'r' }, base, []);
    const written: string[] = [];
    for (let i = 0; i < 10; i++) {
      writeRecord(dir, { ...record, checkout: String(i) }, 'abcdef01');
      written.push(recordFiles(dir)[0] ?? '');
    }
    const kept = recordFiles(dir);
    expect(kept).toHaveLength(8);
    expect(kept).toEqual(written.slice(2).toReversed());
    expect(statSync(kept[0] ?? '').mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(process.platform === 'win32' || !existsSync(MOBILE_MODULES))(
  'the index on the installed Expo SDK',
  () => {
    test(
      'a hit spawns nothing, and a react-native.config.js added re-runs the parts that list the app root, not resolve',
      SLOW,
      async () => {
        const root = expoApp('app');
        await settled();
        await key(root);
        ran();
        const hit = await key(root);
        expect(hit.from).toBe('index');
        expect(ran()).toEqual([]);
        write(join(root, 'react-native.config.js'), 'module.exports = { dependencies: {} };\n');
        const indexed = await key(root);
        expect(ran()).toEqual(['config', 'embed', 'react-native-config']);
        expect(indexed.hash).toBe((await key(root, 'skip')).hash);
        expect(indexed.hash).not.toBe(hit.hash);
      },
    );

    test('an env value change re-runs the parts that read or enumerate the env, not resolve', SLOW, async () => {
      const root = expoApp('app');
      await settled();
      await key(root, 'use', { APP_FLAG: 'a' });
      ran();
      const indexed = await key(root, 'use', { APP_FLAG: 'b' });
      expect(ran()).toEqual(['config', 'embed', 'react-native-config']);
      expect(indexed.hash).toBe((await key(root, 'skip', { APP_FLAG: 'b' })).hash);
    });

    test(
      'a module that appears where the config tried to require one, or a file deep in a listed tree, moves the key',
      SLOW,
      async () => {
        const root = expoApp('app', {
          'app.config.js': [
            "const fs = require('fs');",
            'let local = {};',
            "try { local = require('./overrides/local.js'); } catch {}",
            "const fonts = fs.readdirSync('./fonts', { recursive: true }).map(String).sort();",
            'module.exports = ({ config }) => ({ ...config, extra: { local, fonts } });',
            '',
          ].join('\n'),
          'fonts/a.ttf': 'a',
          'overrides/keep.txt': 'keep',
        });
        await settled();
        await key(root);
        const hit = await key(root);
        write(join(root, 'overrides', 'local.js'), "module.exports = { flag: 'local' };\n");
        const required = await key(root);
        expect(required.hash).not.toBe(hit.hash);
        expect(required.hash).toBe((await key(root, 'skip')).hash);
        await settled();
        await key(root);
        write(join(root, 'fonts', 'sub', 'b.ttf'), 'b');
        const listed = await key(root);
        expect(listed.hash).not.toBe(required.hash);
        expect(listed.hash).toBe((await key(root, 'skip')).hash);
      },
    );

    test('a local plugin directory switching its package.json main moves the key', SLOW, async () => {
      const root = expoApp('app', {
        'app.config.js': "module.exports = ({ config }) => ({ ...config, extra: { v: require('./plug') } });\n",
        'plug/package.json': JSON.stringify({ name: 'plug', main: 'a.js' }),
        'plug/a.js': "module.exports = 'A';\n",
        'plug/b.js': "module.exports = 'B';\n",
      });
      await settled();
      const before = await key(root);
      await key(root);
      write(join(root, 'plug', 'package.json'), JSON.stringify({ name: 'plug', main: 'b.js' }));
      const after = await key(root);
      expect(after.hash).not.toBe(before.hash);
      expect(after.hash).toBe((await key(root, 'skip')).hash);
    });

    test('a config that spawns a child is evaluated on every run', SLOW, async () => {
      const root = expoApp('app', {
        'app.config.js':
          "require('child_process').execFileSync(process.execPath, ['-e', '0']);\nmodule.exports = ({ config }) => config;\n",
      });
      await settled();
      expect((await key(root)).opaque).not.toEqual([]);
      ran();
      await key(root);
      expect(ran()).toEqual(['config', 'embed']);
    });

    test('a .env.local created after a hit moves the key as a full computation does', SLOW, async () => {
      const root = expoApp('app');
      await settled();
      const first = await key(root);
      await key(root);
      write(join(root, '.env.local'), 'APP_FLAG=local\n');
      const indexed = await key(root);
      expect(indexed.hash).not.toBe(first.hash);
      expect(indexed.hash).toBe((await key(root, 'skip')).hash);
    });

    test(
      'a sibling worktree reuses the first checkout autolinking by content and re-runs a config reading its own files',
      SLOW,
      async () => {
        const repo = join(base, 'repo');
        const app = expoApp('repo/app', {
          'app.config.js':
            "module.exports = ({ config }) => ({ ...config, extra: { shared: require('../shared/value.js') } });\n",
        });
        write(join(repo, 'shared', 'value.js'), "module.exports = 'one';\n");
        write(join(repo, '.gitignore'), 'node_modules\n');
        const git = (...args: string[]) =>
          getExecutor().runFile('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
            timeoutMs: 20_000,
          });
        await git('init', '--quiet');
        await git('add', '.');
        await git('commit', '--quiet', '-m', 'init');
        await git('worktree', 'add', '--quiet', join(base, 'sibling'));
        const sibling = realpathSync(join(base, 'sibling', 'app'));
        symlinkSync(MOBILE_MODULES, join(sibling, 'node_modules'));
        await settled();
        const first = await key(app);
        ran();
        const reused = await key(sibling);
        expect(reused.from).toBe('index');
        expect(ran()).toEqual(['config', 'embed']);
        expect(reused.hash).toBe((await key(sibling, 'skip')).hash);
        write(join(base, 'sibling', 'shared', 'value.js'), "module.exports = 'two';\n");
        const moved = await key(sibling);
        expect(moved.hash).not.toBe(first.hash);
        expect(moved.hash).toBe((await key(sibling, 'skip')).hash);
      },
    );
  },
);

describe.skipIf(process.platform === 'win32' || !existsSync(MOBILE_MODULES))('verification and store gates', () => {
  test('a stale record is caught by the in-run check, dropped and counted', SLOW, async () => {
    const root = expoApp('app');
    await settled();
    await key(root);
    corruptRecord(root);
    const stale = await key(root);
    const check = verifyHit(request(root), stale, { env: env(), passes: false });
    expect(await check?.settle(60_000)).toMatchObject({ status: 'disagreed', recorded: stale.hash });
    expect(existsSync(indexOf(root))).toBe(false);
    expect(disagreementCount()).toBe(1);
    expect(takeDisagreements().unreported).toHaveLength(1);
    expect(takeDisagreements().unreported).toHaveLength(0);
  });

  test('with the passes, three hits wait for them and the fourth is checked in the run', SLOW, async () => {
    const root = expoApp('app');
    await settled();
    await key(root);
    const hit = await key(root);
    for (let i = 0; i < 3; i++) expect(verifyHit(request(root), hit, { env: env(), passes: true })).toBeNull();
    expect(readdirSync(fingerprintPendingVerifyDir())).toHaveLength(1);
    const check = verifyHit(request(root), hit, { env: env(), passes: true });
    expect(await check?.settle(60_000)).toMatchObject({ status: 'confirmed' });
    expect(verifyHit(request(root), hit, { env: env(), passes: true })).toBeNull();
  });

  test(
    'the passes verify a pending hit, count no disagreement for a tree edited since, and drop one whose env changed',
    SLOW,
    async () => {
      const root = expoApp('app');
      await settled();
      await key(root);
      const hit = await key(root);
      verifyHit(request(root), hit, { env: env(), passes: true });
      const signal = new AbortController().signal;
      expect(await verifyPending({ perPass: 1, signal })).toBe(1);
      verifyHit(request(root), hit, { env: env(), passes: true });
      write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'edited', slug: 'fp' } }));
      expect(await verifyPending({ perPass: 1, signal })).toBe(1);
      expect(disagreementCount()).toBe(0);
      verifyHit(request(root), hit, { env: env(), passes: true });
      await key(root, 'use', { APP_FLAG: 'other' });
      expect(await verifyPending({ perPass: 1, signal })).toBe(0);
      expect(readdirSync(fingerprintPendingVerifyDir())).toEqual([]);
    },
  );

  test('the local gate refuses an unapplied patch and an input changed during the build', SLOW, async () => {
    const root = expoApp('app');
    await settled();
    const built = await key(root);
    expect(await localStoreGate(request(root), built, { env: env() })).toEqual({ store: true });
    write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'changed', slug: 'fp' } }));
    expect(await localStoreGate(request(root), built, { env: env() })).toMatchObject({ store: false });
    const stamped = expoApp('stamped');
    await settled();
    rmSync(join(stamped, 'node_modules'));
    write(join(stamped, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
    const installed = new Date(Date.now() - 60_000);
    utimesSync(join(stamped, 'node_modules', '.modules.yaml'), installed, installed);
    write(join(stamped, 'patches', 'expo+1.0.0.patch'), '--- a/x');
    expect(await localStoreGate(request(stamped), built, { env: env() })).toMatchObject({
      store: false,
      reason: expect.stringContaining('patches'),
    });
  });

  test('the remote gate recomputes a key the index served before storing under it', SLOW, async () => {
    const root = expoApp('app');
    await settled();
    await key(root);
    const hit = await key(root);
    expect(await remoteStoreGate(request(root), hit, { env: env() })).toEqual({ store: true });
    corruptRecord(root);
    const stale = await key(root);
    expect(await remoteStoreGate(request(root), stale, { env: env() })).toMatchObject({ store: false });
  });
});

describe.skipIf(process.platform === 'win32' || !existsSync(MOBILE_MODULES))('precompute and doctor', () => {
  test(
    'a pass brings a workspace up to date under the env its last run recorded, and verifies pending hits',
    SLOW,
    async () => {
      const root = expoApp('app');
      await settled();
      const signal = new AbortController().signal;
      expect((await precomputePass([request(root)], { admitted: true, signal })).precomputed).toEqual([
        { root, outcome: 'skipped', reason: 'no fingerprint env recorded yet' },
      ]);
      const computed = await key(root, 'use', { APP_FLAG: 'recorded' });
      const hit = await key(root, 'use', { APP_FLAG: 'recorded' });
      verifyHit(request(root), hit, { env: env({ APP_FLAG: 'recorded' }), passes: true });
      ran();
      const pass = await precomputePass([request(root)], { admitted: true, signal });
      expect(pass).toEqual({
        precomputed: [{ root, outcome: 'computed', hash: computed.hash, from: 'index' }],
        verified: 1,
      });
      expect(ran()).toEqual(['config', 'embed', 'react-native-config', 'resolve']);
    },
  );

  test('doctor names ignored fingerprint.config.js keys and a lockfile it cannot read', SLOW, async () => {
    const root = expoApp('app', {
      'fingerprint.config.js': "module.exports = { extraSources: [], ignorePaths: ['ios/**'] };\n",
    });
    rmSync(join(root, 'pnpm-lock.yaml'));
    write(join(root, 'bun.lockb'), '\u0000');
    const notes = await fingerprintNotes(request(root), { env: env() });
    expect(notes.map((note) => note.message)).toEqual([
      "fingerprint.config.js ignorePaths is ignored by Stim's build-cache key",
      'no readable lockfile, so every native package is hashed by its files',
    ]);
  });
});
