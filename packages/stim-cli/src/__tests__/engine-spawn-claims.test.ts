import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareSpawnsOn, spawnDeclared, stopDeclaringSpawnsOn } from '../engine/spawn-claims.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { makeChildProcess } from './_factories.ts';

let dir: string;
let root: string;
let claim: ClaimHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-spawn-claims-'));
  root = join(dir, 'build.lock');
  const got = tryAcquireClaim({ root, mode: 'exclusive' });
  assert(got.acquired);
  claim = got.acquired;
  declareSpawnsOn(claim);
});

afterEach(() => {
  stopDeclaringSpawnsOn(claim);
  releaseClaim(claim);
  rmSync(dir, { recursive: true, force: true });
});

test('a claim that cannot be marked stops the spawn instead of running it unprotected', () => {
  rmSync(root, { recursive: true, force: true });
  let spawned = false;
  expect(() =>
    spawnDeclared(() => {
      spawned = true;
      return makeChildProcess();
    }),
  ).toThrow(/ENOENT/);
  expect(spawned).toBe(false);
});

test('a child whose identity cannot be captured keeps the claim pending until it exits', () => {
  const child = spawnDeclared(() => makeChildProcess());
  const pending = readClaimSet(root).live[0];
  expect(pending?.childDeclared).toBe(true);
  expect(pending?.child).toBe(null);
  child.emit('exit', 0, null);
  expect(readClaimSet(root).live[0]?.childDeclared).toBe(false);
});
