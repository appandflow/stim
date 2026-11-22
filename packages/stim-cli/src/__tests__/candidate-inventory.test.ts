import type { GcMark } from '@stim-cli/core/state';
import { candidateInventory } from '../daemon/candidate-inventory.ts';

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const mark = (root: string, minutes = 0): GcMark => ({
  v: 2,
  root,
  device: 1,
  markedAt: at(minutes),
  lastActivityAt: null,
  candidates: [],
});
const candidate = (path: string, bytes: number | null, minutes = 0, kind: 'outputs' | 'cargo-target' = 'outputs') => ({
  kind,
  path,
  device: 1,
  bytes,
  measuredAt: bytes === null ? null : at(minutes),
});

test('deduplicates kind/path identities using the latest cached evidence and keeps known zero separate from unknown', () => {
  const old = {
    ...mark('/one', 60),
    candidates: [candidate('/shared', 5, 60), candidate('/shared', 7, 60, 'cargo-target'), candidate('/zero', 0, 60)],
  };
  const recent = { ...mark('/two', 10), candidates: [candidate('/shared', 11, 5), candidate('/unknown', null)] };
  expect(candidateInventory([old, recent], true, true).outputs).toEqual({
    state: 'ready',
    count: 4,
    knownBytes: 18,
    unknownSizeCount: 1,
    oldestMarkedAt: at(60),
  });
});

test('uses each subtype generation and retains kept candidates while worktree sizes remain unknown', () => {
  const worktree = {
    markedAt: at(2880),
    source: '/source',
    head: 'abc',
    keys: ['/repo'],
    clean: true,
    pushed: true,
    finished: null,
    emptyBranch: false,
    activity: null,
    lastUsedAt: null,
  };
  const saved = {
    ...mark('/repo', 5),
    candidates: [candidate('/repo/build', 10)],
    worktree,
    dependencies: {
      markedAt: at(180),
      role: 'source' as const,
      keys: ['/repo'],
      candidates: [{ ...candidate('/repo/node_modules', 50), keep: { reason: 'active', at: at(180) } }],
    },
  };
  expect(candidateInventory([saved], true, true)).toMatchObject({
    readState: 'ready',
    outputs: { state: 'ready', count: 1, knownBytes: 10, oldestMarkedAt: at(5) },
    dependencies: { state: 'ready', count: 1, knownBytes: 50, oldestMarkedAt: at(180) },
    worktrees: { state: 'ready', count: 1, knownBytes: 0, unknownSizeCount: 1, oldestMarkedAt: at(2880) },
  });
});

test('distinguishes missing subtype evidence from a verified empty observation without partial zero totals', () => {
  const observed = {
    ...mark('/observed'),
    dependencies: { markedAt: at(60), role: 'linked' as const, keys: ['/observed'], candidates: [] },
  };
  const absent = mark('/absent');
  const complete = candidateInventory([observed], true, true);
  expect(complete.dependencies).toEqual({
    state: 'ready',
    count: 0,
    knownBytes: 0,
    unknownSizeCount: 0,
    oldestMarkedAt: at(60),
  });
  expect(complete.worktrees).toEqual({ state: 'unavailable' });
  expect(candidateInventory([observed, absent], true, true).dependencies).toEqual({
    state: 'partial',
    oldestMarkedAt: at(60),
  });
  expect(candidateInventory([absent], false, true).outputs).toEqual({ state: 'partial', oldestMarkedAt: at(0) });
});

test.each([
  { complete: true, listed: true, readState: 'ready', state: 'ready' },
  { complete: false, listed: true, readState: 'partial', state: 'unavailable' },
  { complete: false, listed: false, readState: 'unavailable', state: 'unavailable' },
])('reports empty saved inventory only after a complete read: $readState', ({ complete, listed, readState, state }) => {
  const result = candidateInventory([], complete, listed);
  expect(result.readState).toBe(readState);
  const empty = { state: 'ready', count: 0, knownBytes: 0, unknownSizeCount: 0 };
  expect(result.outputs).toEqual(complete ? empty : { state });
  expect(result.dependencies).toEqual(complete ? empty : { state });
  expect(result.worktrees).toEqual(complete ? empty : { state });
});

test('invalid generations reduce coverage and malformed cached sizes remain unknown', () => {
  const invalid = { ...mark('/invalid'), markedAt: 'invalid', candidates: [candidate('/unproved', 999)] };
  const valid = { ...mark('/valid'), candidates: [candidate('/negative', -1), candidate('/nonfinite', Infinity)] };
  const result = candidateInventory([invalid, valid], true, true);
  expect(result.outputs).toEqual({
    state: 'partial',
    count: 2,
    knownBytes: 0,
    unknownSizeCount: 2,
    oldestMarkedAt: at(0),
  });
});

test('newer unknown evidence does not resurrect an older shared-path estimate', () => {
  const old = { ...mark('/old', 60), candidates: [candidate('/shared', 100, 60)] };
  const recent = { ...mark('/recent'), candidates: [candidate('/shared', null)] };
  expect(candidateInventory([old, recent], true, true).outputs).toMatchObject({
    count: 1,
    knownBytes: 0,
    unknownSizeCount: 1,
  });
});
