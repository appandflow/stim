import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allDrained, buildClaimRoot, keptEntries, readBuildClaims } from '../engine-store/claims.ts';
import { collectStore } from '../engine-store/gc.ts';
import { keptJobUses, readJobUses, recordJobUse } from '../engine-store/jobs.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim, updateClaimDetails } from '../ownership-claim.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';
import * as engineSwitch from '../daemon/engine-switch.ts';
import { followEngine } from '../stimd/engine-follow.ts';
import { getExecutor } from '../exec.ts';

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-engine-claims-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const plant = (build: string, owner: ReturnType<typeof liveClaimOwner>, details: Record<string, unknown>, id: string) =>
  plantClaim(buildClaimRoot(root, build), 'shared', owner, { claimId: id, details });
const survey = (build: string) => readClaimSet(buildClaimRoot(root, build));

describe('the drain decision', () => {
  test.each([
    { name: 'every live claim drained', claims: [true, true], gone: [], expected: true },
    { name: 'one live claim with pinned work', claims: [true, false], gone: [], expected: false },
    {
      name: 'a gone holder that never drained does not hold the switch',
      claims: [true],
      gone: [false],
      expected: true,
    },
  ])('$name', ({ claims, gone, expected }) => {
    claims.forEach((drained, index) => plant(A, liveClaimOwner(), { drained }, `live-${index}`));
    gone.forEach((drained, index) => plant(A, goneClaimOwner(), { drained }, `gone-${index}`));
    expect(allDrained(survey(A))).toBe(expected);
  });

  test('a claim whose holder cannot be identified holds the switch', () => {
    plant(A, liveClaimOwner(), { drained: true }, 'live');
    plant(A, { pid: 4242, processToken: 'nonsense' }, { drained: true }, 'unknown');
    expect(allDrained(survey(A))).toBe(false);
  });

  test('a claim updated in place stays one claim and is read with its new details', () => {
    const taken = tryAcquireClaim({ root: buildClaimRoot(root, A), mode: 'shared', details: { drained: false } });
    expect(allDrained(survey(A))).toBe(false);
    assert(taken.acquired);
    const updated = updateClaimDetails(taken.acquired, { drained: true });
    expect(survey(A).live.map((claim) => claim.details)).toEqual([{ drained: true }]);
    expect(allDrained(survey(A))).toBe(true);
    expect(releaseClaim(updated)).toBe(true);
    expect(survey(A).live).toEqual([]);
  });
});

describe('the GC keep-set', () => {
  test('keeps the pointer records, every claimed build and the builds live claims record, not a gone claim', () => {
    plant(A, liveClaimOwner(), { drained: false, engineDirs: ['cccccccccccc'] }, 'live');
    plant(B, goneClaimOwner(), { drained: true, engineDirs: ['dddddddddddd'] }, 'gone');
    const records = {
      current: { dir: 'eeeeeeeeeeee' },
      previous: 'ffffffffffff',
      staged: { dir: '111111111111' },
    };
    expect([...keptEntries(records, readBuildClaims(root))].toSorted()).toEqual(
      ['111111111111', A, 'cccccccccccc', 'eeeeeeeeeeee', 'ffffffffffff'].toSorted(),
    );
  });

  test('keeps a build whose claim cannot be resolved', () => {
    plant(B, { pid: 4242, processToken: 'nonsense' }, {}, 'unknown');
    const none = { current: null, previous: null, staged: null };
    expect([...keptEntries(none, readBuildClaims(root))]).toEqual([B]);
  });

  test('keeps the adopted builds named by a readable pending claim after its owner exits', async () => {
    const { spawn } = await import('node:child_process');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: A, version: '1' }));
    writeFileSync(join(root, 'staged.json'), JSON.stringify({ format: 1, dir: B, version: '2' }));
    const engine = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build: A });
    const run = vi.spyOn(getExecutor(), 'runFileAsync');
    const follower = followEngine(() => {});
    assert(follower);
    try {
      const script = `
      import { tryAcquireClaim, markClaimChildPending } from '@stim-cli/core/ownership-claim';
      const claim = tryAcquireClaim({ root: process.argv[1], mode: 'shared',
        details: { drained: false, engineDirs: [process.argv[2]] } }).acquired;
      if (!claim) throw new Error('fixture claim unavailable');
      markClaimChildPending(claim);
    `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, buildClaimRoot(root, A), B], {
        cwd: join(process.cwd(), 'packages/stim-cli'),
        stdio: 'ignore',
      });
      expect(await new Promise<number | null>((done) => child.once('close', done))).toBe(0);
      const claims = readBuildClaims(root);
      expect(allDrained(survey(A))).toBe(false);
      expect([...keptEntries({ current: null, previous: null, staged: null }, claims)].toSorted()).toEqual([A, B]);
      follower.record(false, []);
      expect(await follower.check(() => false)).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      follower?.release();
      run.mockRestore();
      engine.mockRestore();
    }
  });
});

describe('offload job builds on a worker', () => {
  const HOUR = 60 * 60_000;
  const tree = (build: string) => {
    mkdirSync(join(root, build, 'dist'), { recursive: true });
    writeFileSync(join(root, build, '.stim-manifest.json'), JSON.stringify({ format: 1, build, version: '1.0.0' }));
  };
  const used = (build: string, version: string, hoursAgo: number) => {
    mkdirSync(join(root, 'jobs'), { recursive: true });
    const usedAt = new Date(Date.now() - hoursAgo * HOUR).toISOString();
    writeFileSync(join(root, 'jobs', `${build}.json`), JSON.stringify({ format: 1, version, usedAt }));
  };
  /** A cacache index entry for `stim-<version>.tgz` and its content file, both older than the cache trim's week. */
  const tarball = (version: string): string[] => {
    const cache = join(root, '.npm-cache', '_cacache');
    const digest = createHash('sha512').update(version).digest();
    const hex = digest.toString('hex');
    const content = join(cache, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    const index = join(cache, 'index-v5', version.replaceAll('.', ''), 'entry');
    const key = `make-fetch-happen:request-cache:https://registry.npmjs.org/stim/-/stim-${version}.tgz`;
    for (const [file, text] of [
      [content, 'tgz'],
      [index, `hash\t${JSON.stringify({ key, integrity: `sha512-${digest.toString('base64')}` })}`],
    ] as const) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      const old = new Date(Date.now() - 8 * 24 * HOUR);
      utimesSync(file, old, old);
    }
    return [content, index];
  };

  test('GC keeps the three client builds jobs used most recently within a day, and their npm tarballs', () => {
    const builds = ['111111111111', '222222222222', '333333333333', '444444444444', '555555555555'];
    builds.forEach(tree);
    builds.forEach((build, index) => used(build, `1.0.${index + 1}`, index === 4 ? 30 : index + 1));
    const kept = tarball('1.0.1');
    const dropped = tarball('1.0.4');
    expect(keptJobUses(readJobUses(root), Date.now()).map((use) => use.build)).toEqual(builds.slice(0, 3));
    expect(collectStore(root).toSorted()).toEqual([builds[3], builds[4]]);
    expect(kept.every((file) => existsSync(file))).toBe(true);
    expect(dropped.some((file) => existsSync(file))).toBe(false);
  });

  test('a build installed for a job but not yet started is kept by the record its install wrote', () => {
    tree('666666666666');
    recordJobUse(root, '666666666666', '1.0.6');
    expect(collectStore(root)).toEqual([]);
  });
});
