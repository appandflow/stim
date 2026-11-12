import assert from 'node:assert/strict';
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { fingerprint, type Fingerprint } from '../fingerprint/evaluate.ts';
import { fingerprintForBuild } from '../fingerprint/operation.ts';
import * as daemonClient from '../daemon/client.ts';
import { testContext } from './_context.ts';
import {
  checkRead,
  indexDir,
  newRecord,
  newerThanInstall,
  nowNs,
  recordFiles,
  takeRead,
  writeRecord,
} from '../fingerprint/index-store.ts';
import { fingerprintNotes } from '../fingerprint/doctor.ts';
import { canonicalJson, isUncertain, sha256 } from '../fingerprint/key.ts';
import { precomputePass } from '../fingerprint/precompute.ts';
import { disagreementCount, takeDisagreements, verifyHit, verifyPending } from '../fingerprint/verify.ts';

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
    runFileAsync: (file, args, options) => {
      if (args.some((arg: string) => arg.endsWith('fp-trace.cjs'))) spawned.push([file, ...args]);
      return real.runFileAsync(file, args, options);
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

test('install freshness follows declared custom patches and nested patch-package files', () => {
  const root = join(base, 'patch-project');
  const declared = join(root, 'vendor-patches', 'nested', 'declared.patch');
  const nested = join(root, 'custom patches', 'nested', 'package.patch');
  const stamp = join(root, 'node_modules', '.modules.yaml');
  write(
    join(root, 'package.json'),
    JSON.stringify({
      pnpm: { patchedDependencies: { 'fixture@1.0.0': 'vendor-patches/nested/declared.patch' } },
      scripts: { postinstall: 'patch-package --patch-dir="custom patches"' },
    }),
  );
  write(declared, 'declared patch');
  write(nested, 'nested patch');
  write(stamp, 'layoutVersion: 5\n');
  const past = new Date(Date.now() - 60_000);
  utimesSync(stamp, past, past);
  expect(newerThanInstall({ project: root, install: root })).toBe(declared);
  const future = new Date(Date.now() + 60_000);
  utimesSync(stamp, future, future);
  expect(newerThanInstall({ project: root, install: root })).toBeNull();
  const newer = new Date(Date.now() + 120_000);
  utimesSync(nested, newer, newer);
  expect(newerThanInstall({ project: root, install: root })).toBe(nested);
});

test('a newer npm lockfile permits caching when it describes the carried install', () => {
  const root = join(base, 'warmed-worktree');
  const lockfile = join(root, 'package-lock.json');
  const stamp = join(root, 'node_modules', '.package-lock.json');
  const lock = (packages: Record<string, object>) => JSON.stringify({ lockfileVersion: 3, packages });
  const name = 'node_modules/fixture';
  const entry = { version: '1.0.0', resolved: 'https://registry.example/fixture.tgz', integrity: 'sha512-original' };
  write(stamp, lock({ [name]: entry }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(stamp, past, past);
  const roots = { project: root, install: root };

  write(
    lockfile,
    lock({ '': { name: 'app' }, [name]: entry, 'node_modules/optional': { version: '2.0.0', optional: true } }),
  );
  expect(newerThanInstall(roots)).toBeNull();

  const patch = join(root, 'patches', 'fixture+1.0.0.patch');
  write(patch, 'changed after install');
  expect(newerThanInstall(roots)).toBe(patch);

  write(lockfile, lock({ [name]: { ...entry, integrity: 'sha512-replacement' } }));
  expect(newerThanInstall(roots)).toBe(lockfile);

  write(lockfile, lock({ '': { name: 'app' } }));
  expect(newerThanInstall(roots)).toBe(lockfile);

  write(lockfile, lock({ [name]: entry, 'node_modules/missing': { version: '2.0.0' } }));
  expect(newerThanInstall(roots)).toBe(lockfile);
});

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

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  STIM_HOME: process.env.STIM_HOME,
  ...extra,
});
const request = (root: string) => ({ root, target: { platform: 'ios' as const }, embedMode: 'development' as const });

async function key(
  root: string,
  index: 'use' | 'skip' | 'refresh' = 'use',
  extra: NodeJS.ProcessEnv = {},
): Promise<Fingerprint> {
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

    test('refresh computes every evaluator again and records a reusable result', SLOW, async () => {
      const root = expoApp('refresh');
      await settled();
      const first = await key(root);
      ran();
      const refreshed = await fingerprintForBuild(
        root,
        { platform: 'ios' },
        {
          operation: testContext({ projectRoot: root, env: env() }),
          embedMode: 'development',
          consult: false,
        },
      );
      if ('uncertain' in refreshed) throw new Error(refreshed.uncertain);
      expect(refreshed.fingerprint.hash).toBe(first.hash);
      expect(refreshed.fingerprint.from).toBe('evaluated');
      expect(refreshed.check).toBeNull();
      expect(ran()).toEqual(['config', 'embed', 'react-native-config', 'resolve']);
      const reused = await key(root);
      expect(reused.hash).toBe(refreshed.fingerprint.hash);
      expect(reused.from).toBe('index');
      expect(ran()).toEqual([]);
    });

    test('a queued index verification uses the operation home rather than the ambient home', SLOW, async () => {
      const root = expoApp('selected-home');
      const home = join(base, 'selected-home-state');
      const selectedEnv = { ...env(), STIM_HOME: home };
      const operation = testContext({ home, projectRoot: root, env: selectedEnv });
      const availability = vi.spyOn(daemonClient, 'backgroundPassesAvailable').mockResolvedValue(true);
      try {
        await settled();
        const first = await fingerprint(
          root,
          { platform: 'ios' },
          { env: selectedEnv, operation, embedMode: 'development' },
        );
        if (isUncertain(first)) throw new Error(first.uncertain);
        const hit = await fingerprintForBuild(root, { platform: 'ios' }, { operation, embedMode: 'development' });
        if ('uncertain' in hit) throw new Error(hit.uncertain);
        expect(hit.fingerprint.from).toBe('index');
        expect(hit.check).toBeNull();
        expect(readdirSync(join(home, 'fingerprint', 'pending-verify'))).toHaveLength(1);
        expect(existsSync(fingerprintPendingVerifyDir())).toBe(false);
      } finally {
        availability.mockRestore();
      }
    });

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
      'a module that appears where the config tried to require or resolve one, or a file deep in a listed tree, moves the key',
      SLOW,
      async () => {
        const root = expoApp('app', {
          'app.config.js': [
            "const fs = require('fs');",
            'let local = {};',
            "try { local = require('./overrides/local.js'); } catch {}",
            "const fonts = fs.readdirSync('./fonts', { recursive: true }).map(String).sort();",
            'let has = false;',
            "try { require.resolve('./cfg/local.json'); has = true; } catch {}",
            'module.exports = ({ config }) => ({ ...config, extra: { local, fonts, has } });',
            '',
          ].join('\n'),
          'fonts/a.ttf': 'a',
          'overrides/keep.txt': 'keep',
          'cfg/keep.txt': 'keep',
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
        await settled();
        await key(root);
        write(join(root, 'cfg', 'local.json'), '{}');
        const resolved = await key(root);
        expect(resolved.hash).not.toBe(listed.hash);
        expect(resolved.hash).toBe((await key(root, 'skip')).hash);
      },
    );

    test.each([
      { listed: "fs.readdirSync('./drop')", late: './drop/late.txt' },
      { listed: "fs.readdirSync('./drop', { recursive: true })", late: './drop/sub/late.txt' },
    ])(
      'a directory the config lists ($listed) and then writes into is not recorded from the later listing',
      SLOW,
      async ({ listed, late }) => {
        const root = expoApp('app', {
          'app.config.js': [
            "const fs = require('fs');",
            'let entries = null;',
            "if (!process.argv.includes('embed')) {",
            `  entries = ${listed}.map(String).sort();`,
            `  fs.writeFileSync('${late}', 'late');`,
            '}',
            'module.exports = ({ config }) => ({ ...config, extra: { entries } });',
            '',
          ].join('\n'),
          'drop/sub/a.txt': 'a',
        });
        await settled();
        await key(root);
        ran();
        const second = await key(root);
        expect(ran()).toContain('config');
        expect(second.hash).toBe((await key(root, 'skip')).hash);
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

  test('the next build reports a queued disagreement once in its selected home', SLOW, async () => {
    const root = expoApp('queued-warning');
    await settled();
    await key(root);
    corruptRecord(root);
    const stale = await key(root);
    const check = verifyHit(request(root), stale, { env: env(), passes: false });
    expect(await check?.settle(60_000)).toMatchObject({ status: 'disagreed' });
    const home = process.env.STIM_HOME;
    assert(home);
    const operation = testContext({ home, env: env(), projectRoot: root });
    const warnings: string[] = [];
    const first = await fingerprintForBuild(
      root,
      { platform: 'ios' },
      {
        operation,
        embedMode: 'development',
        onDisagreement: (line) => warnings.push(line),
      },
    );
    if ('check' in first) await first.check?.settle(60_000);
    expect(warnings).toEqual([expect.stringContaining('an earlier cache lookup used fingerprint')]);
    const second = await fingerprintForBuild(
      root,
      { platform: 'ios' },
      {
        operation,
        embedMode: 'development',
        onDisagreement: (line) => warnings.push(line),
      },
    );
    if ('check' in second) await second.check?.settle(60_000);
    expect(warnings).toHaveLength(1);
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

  test('a pending item for another root is left queued without evaluating it', async () => {
    const first = expoApp('first');
    const second = expoApp('second');
    const directory = fingerprintPendingVerifyDir();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'pending.json'),
      JSON.stringify({
        root: second,
        target: { platform: 'ios' },
        embedMode: 'development',
        hash: 'a',
        inputs: [],
        envRef: { id: 'fixture', digest: 'fixture' },
      }),
    );
    const count = await verifyPending({
      perPass: 1,
      signal: new AbortController().signal,
      root: first,
      file: 'pending.json',
    });
    expect(count).toBe(0);
    expect(readdirSync(directory)).toHaveLength(1);
    expect(ran()).toEqual([]);
  });

  test('a pending item remains queued when its root cannot be inspected', async () => {
    const root = expoApp('inaccessible');
    const directory = fingerprintPendingVerifyDir();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'pending.json'),
      JSON.stringify({
        root,
        target: { platform: 'ios' },
        embedMode: 'development',
        hash: 'a',
        inputs: [],
        envRef: { id: 'fixture', digest: 'fixture' },
      }),
    );
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const spy = vi.spyOn(realpathSync, 'native').mockImplementation(() => {
      throw denied;
    });
    try {
      expect(await verifyPending({ perPass: 1, signal: new AbortController().signal, file: 'pending.json' })).toBe(0);
      expect(readdirSync(directory)).toHaveLength(1);
      expect(ran()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('a cached embedded part that recorded a private read is refused', SLOW, async () => {
    const root = expoApp('cached-private');
    const secret = 'cached-private-fixture';
    const requester = env({ STIM_ACCESS_TICKET: secret });
    await settled();
    const initial = await fingerprint(
      root,
      { platform: 'ios' },
      { env: requester, embedMode: 'development', index: 'use' },
    );
    expect(isUncertain(initial)).toBe(false);
    const [file] = recordFiles(indexOf(root));
    assert(file);
    const record: { parts: Record<string, { env: Array<[string, string | null]>; envNames: string[] }> } = JSON.parse(
      readFileSync(file, 'utf8'),
    );
    const embedded = record.parts['configEmbedded:env'];
    assert(embedded);
    embedded.env.push(['STIM_ACCESS_TICKET', sha256(canonicalJson(['value', secret]))]);
    embedded.envNames.push('STIM_ACCESS_TICKET');
    writeFileSync(file, JSON.stringify(record));
    ran();
    const result = await fingerprint(
      root,
      { platform: 'ios' },
      { env: requester, embedMode: 'development', index: 'use' },
    );
    expect(result).toMatchObject({ uncertain: expect.stringContaining('private Stim credential') });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(ran()).not.toContain('embed');
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
      });
      expect(ran()).toEqual([]);
      expect(await verifyPending({ perPass: 1, signal })).toBe(1);
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
      'an input cannot be safely reproduced on a build worker, so builds are not offloaded',
    ]);
  });
});
