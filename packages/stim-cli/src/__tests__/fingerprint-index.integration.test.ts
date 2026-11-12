import {
  MOBILE_MODULES,
  SLOW,
  LATER,
  base,
  write,
  expoApp,
  settled,
  env,
  key,
  ran,
} from './fingerprint-index-harness.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { fingerprint } from '../fingerprint/evaluate.ts';
import { fingerprintForBuild } from '../fingerprint/operation.ts';
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
const request = (root: string) => ({ root, target: { platform: 'ios' as const }, embedMode: 'development' as const });

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
