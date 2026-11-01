import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { deviceLeasePath, takeLease, type LeaseIo, type WorkspaceLeases } from '../engine/device-lease.ts';
import { selectFromPool } from '../engine/device-pool.ts';

const ROOT = '/worktree/mine';
const OTHER = '/worktree/theirs';
const FIRST = '00008030-AAA';
const SECOND = '00008120-BBB';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function harness(start = Date.parse('2026-09-02T12:00:00.000Z')) {
  const files = new Map<string, string>();
  const holders = new Map<string, WorkspaceLeases>();
  let clock = start;
  const io: LeaseIo = {
    now: () => clock,
    readLease: (path) => files.get(path) ?? null,
    writeLease: (path, body) => {
      files.set(path, body);
    },
    removeLease: (path) => {
      files.delete(path);
    },
    listLeaseNames: () => [...files.keys()].map((path) => basename(path)),
    withLeaseLock: (_lock, fn) => fn(),
    readHolder: (root) => structuredClone(holders.get(root) ?? {}),
    writeHolder: (root, leases) => {
      holders.set(root, structuredClone(leases));
    },
  };
  const warnings: string[] = [];
  const slept: number[] = [];
  return {
    io,
    files,
    holders,
    warnings,
    slept,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    warn: (line: string) => warnings.push(line),
  };
}

type Harness = ReturnType<typeof harness>;

const NONE = () => ({ message: 'No physical iOS device is connected.', remedy: 'Plug one in.' });

function pool(h: Harness, ids: string[], over: Record<string, unknown> = {}) {
  return selectFromPool({
    root: ROOT,
    platform: 'ios',
    idLabel: 'udid',
    list: () => ids.map((id) => ({ id, name: `name-${id}` })),
    noCandidates: NONE,
    waitSeconds: 60,
    now: h.now,
    sleep: h.sleep,
    warn: h.warn,
    io: h.io,
    ...over,
  });
}

function leasedBy(h: Harness, root: string, id: string, durationMs = 600_000) {
  const taken = takeLease({ root, platform: 'ios', id, deviceName: `name-${id}`, kind: 'declared', durationMs }, h.io);
  assert(taken.status === 'taken');
  if (root !== ROOT) h.holders.delete(root);
  return taken.lease;
}

describe('choosing from the pool', () => {
  test('a candidate another workspace holds is skipped', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    const result = await pool(h, [FIRST, SECOND]);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(SECOND);
  });

  test('every candidate unreadable refuses, naming the files rather than the phones', async () => {
    const h = harness();
    h.files.set(deviceLeasePath('ios', 'A-CORRUPT'), '{ not a lease');
    const result = await pool(h, ['A-CORRUPT']);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(/Every connected device has an unreadable lease file/);
    expect(result.refusal.message).toContain(deviceLeasePath('ios', 'A-CORRUPT'));
    expect(result.refusal.remedy).toMatch(/`stim gc` reports them on every run/);
    expect(result.refusal.lease).toEqual({
      platform: null,
      id: null,
      deviceName: null,
      holder: null,
      expiresAt: null,
    });
    expect(h.slept).toEqual([]);
  });
});

describe('waiting for a free device', () => {
  test('the wait running out names every holder, once with each expiry', async () => {
    const h = harness();
    const first = leasedBy(h, OTHER, FIRST);
    leasedBy(h, '/worktree/third', SECOND);
    const result = await pool(h, [FIRST, SECOND], { waitSeconds: 4 });
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(/Every connected device is leased by another workspace/);
    expect(result.refusal.message).toMatch(/this run waited 4s for one/);
    expect(result.refusal.message).toMatch(new RegExp(`${FIRST} \\(${OTHER}, until \\d\\d:`));
    expect(result.refusal.message).toMatch(new RegExp(`${SECOND} \\(/worktree/third, until`));
    expect(result.refusal.lease).toEqual({
      platform: 'ios',
      id: FIRST,
      deviceName: `name-${FIRST}`,
      holder: OTHER,
      expiresAt: first.expiresAt,
    });
  });
});
