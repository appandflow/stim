import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declareSpawnsOn,
  fenceDeclaredSpawns,
  refuseDeclaredSpawns,
  spawnDeclared,
  stopDeclaringSpawnsOn,
} from '../engine/spawn-claims.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { testContext } from './_context.ts';
import { makeChildProcess } from './_factories.ts';

let dir: string;
let root: string;
let claim: ClaimHandle;
const context = testContext();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-spawn-claims-'));
  root = join(dir, 'build.lock');
  const got = tryAcquireClaim({ root, mode: 'exclusive' });
  assert(got.acquired);
  claim = got.acquired;
  declareSpawnsOn(context, claim);
});

afterEach(() => {
  stopDeclaringSpawnsOn(context, claim);
  releaseClaim(claim);
  rmSync(dir, { recursive: true, force: true });
});

test('a claim that cannot be marked stops the spawn instead of running it unprotected', () => {
  rmSync(root, { recursive: true, force: true });
  let spawned = false;
  expect(() =>
    spawnDeclared(context, () => {
      spawned = true;
      return makeChildProcess();
    }),
  ).toThrow(/ENOENT/);
  expect(spawned).toBe(false);
});

test('a child whose identity cannot be captured keeps the claim pending until it exits', () => {
  const child = spawnDeclared(context, () => makeChildProcess());
  const pending = readClaimSet(root).live[0];
  expect(pending?.childDeclared).toBe(true);
  expect(pending?.child).toBe(null);
  child.emit('exit', 0, null);
  expect(readClaimSet(root).live[0]?.childDeclared).toBe(false);
});

test("a child is recorded only on its own operation's claims, and a refusal stops only that operation", () => {
  const other = testContext();
  const otherRoot = join(dir, 'other.lock');
  const got = tryAcquireClaim({ root: otherRoot, mode: 'exclusive' });
  assert(got.acquired);
  declareSpawnsOn(other, got.acquired);
  try {
    const child = spawnDeclared(context, () => makeChildProcess());
    expect(readClaimSet(root).live[0]?.childDeclared).toBe(true);
    expect(readClaimSet(otherRoot).live[0]?.childDeclared).toBe(false);
    child.emit('exit', 0, null);
    refuseDeclaredSpawns(other, 'the other run was cancelled');
    expect(() => spawnDeclared(other, () => makeChildProcess())).toThrow('the other run was cancelled');
    spawnDeclared(context, () => makeChildProcess()).emit('exit', 0, null);
  } finally {
    stopDeclaringSpawnsOn(other, got.acquired);
    releaseClaim(got.acquired);
  }
});

test('a pending fence remains until overlapping declared children settle', async () => {
  const earlier = spawnDeclared(context, () => makeChildProcess());
  const fence = fenceDeclaredSpawns(context);
  const later = spawnDeclared(context, () => makeChildProcess());
  expect(readClaimSet(root).live[0]?.childDeclared).toBe(true);
  expect(readClaimSet(root).live[0]?.child).toBe(null);
  let finished = false;
  const pending = fence.finish().then(() => {
    finished = true;
    return undefined;
  });
  earlier.emit('exit', 0, null);
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(readClaimSet(root).live[0]?.childDeclared).toBe(true);
  later.emit('exit', 0, null);
  await pending;
  expect(readClaimSet(root).live[0]?.childDeclared).toBe(false);
});

test('every fenced claim stays pending for children declared on either claim', async () => {
  const engine = tryAcquireClaim({ root: join(dir, 'engine.lock'), mode: 'shared' }).acquired;
  assert(engine);
  const earlier = spawnDeclared(context, () => makeChildProcess());
  declareSpawnsOn(context, engine);
  const fence = fenceDeclaredSpawns(context);
  const other = testContext();
  declareSpawnsOn(other, claim);
  const later = spawnDeclared(other, () => makeChildProcess());
  try {
    let finished = false;
    const pending = fence.finish().then(() => {
      finished = true;
      return undefined;
    });
    earlier.emit('exit', 0, null);
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(readClaimSet(engine.root).live[0]?.childDeclared).toBe(true);
    later.emit('exit', 0, null);
    await pending;
    expect(readClaimSet(engine.root).live[0]?.childDeclared).toBe(false);
  } finally {
    stopDeclaringSpawnsOn(other, claim);
    stopDeclaringSpawnsOn(context, engine);
    releaseClaim(engine);
  }
});

test('overlapping fences keep both claims pending until both finish', async () => {
  const engine = tryAcquireClaim({ root: join(dir, 'engine.lock'), mode: 'shared' }).acquired;
  assert(engine);
  declareSpawnsOn(context, engine);
  const first = fenceDeclaredSpawns(context);
  const second = fenceDeclaredSpawns(context);
  try {
    let done = false;
    const finished = first.finish().then(() => {
      done = true;
      return undefined;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(readClaimSet(claim.root).live[0]?.childDeclared).toBe(true);
    expect(readClaimSet(engine.root).live[0]?.childDeclared).toBe(true);
    await second.finish();
    await finished;
    expect(readClaimSet(claim.root).live[0]?.childDeclared).toBe(false);
    expect(readClaimSet(engine.root).live[0]?.childDeclared).toBe(false);
  } finally {
    stopDeclaringSpawnsOn(context, engine);
    releaseClaim(engine);
  }
});

test('an unverified child on one claim retains every linked claim', async () => {
  const engine = tryAcquireClaim({ root: join(dir, 'engine.lock'), mode: 'shared' }).acquired;
  assert(engine);
  declareSpawnsOn(context, engine);
  const fence = fenceDeclaredSpawns(context);
  try {
    await expect(fence.finish(Object.assign(new Error('unverified'), { reportCleanup: true }))).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    expect(readClaimSet(claim.root).live[0]?.childDeclared).toBe(true);
    expect(readClaimSet(engine.root).live[0]?.childDeclared).toBe(true);
  } finally {
    stopDeclaringSpawnsOn(context, engine);
    releaseClaim(engine);
  }
});

test('a failed fenced child keeps ownership pending and refuses another fence', async () => {
  const fence = fenceDeclaredSpawns(context);
  const error = Object.assign(new Error('cleanup unverified'), { reportCleanup: true });
  await expect(fence.finish(error)).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
  expect(readClaimSet(root).live[0]?.childDeclared).toBe(true);
  expect(() => fenceDeclaredSpawns(context)).toThrow(/ownership/);
});
