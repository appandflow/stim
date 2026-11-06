import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allDrained, buildClaimRoot, keptEntries, readBuildClaims } from '../engine-store/claims.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim, updateClaimDetails } from '../ownership-claim.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

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
});
