import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStateDir } from '../index.ts';
import {
  lastNativeUseFrom,
  lastUseFrom,
  readBuildHistory,
  readLastBuilds,
  workspaceLastUsed,
} from '../state/workspace-state.ts';

describe('last use of a workspace', () => {
  const at = (iso: string) => Date.parse(iso);

  test('newer evidence than the recorded lastUsedAt wins, so a long Metro session is not idle', () => {
    expect(
      lastUseFrom({ lastUsedAt: '2026-09-01T00:00:00Z', lastBuild: { startedAt: '2026-09-20T00:00:00Z' } }, [
        at('2026-09-21T00:00:00Z'),
      ]),
    ).toBe(at('2026-09-21T00:00:00Z'));
    expect(lastUseFrom({ lastUsedAt: '2026-09-22T00:00:00Z' }, [at('2026-09-21T00:00:00Z')])).toBe(
      at('2026-09-22T00:00:00Z'),
    );
  });

  test('a workspace that recorded no use was last used when it was created; corrupt state or no directory leaves it unknown', () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-last-use-'));
    vi.stubEnv('STIM_HOME', home);
    try {
      const root = '/w/never-used';
      expect(workspaceLastUsed(root)).toBeNaN();
      mkdirSync(workspaceStateDir(root), { recursive: true });
      const metadata = join(workspaceStateDir(root), 'workspace.json');
      writeFileSync(metadata, '{}');
      utimesSync(metadata, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
      expect(workspaceLastUsed(root)).toBe(at('2026-09-01T00:00:00Z'));
      writeFileSync(join(workspaceStateDir(root), 'state.json'), '{not json');
      expect(workspaceLastUsed(root)).toBeNaN();
      writeFileSync(
        join(workspaceStateDir(root), 'state.json'),
        JSON.stringify({ lastUsedAt: '2026-09-04T00:00:00Z' }),
      );
      expect(workspaceLastUsed(root)).toBe(at('2026-09-04T00:00:00Z'));
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('last native run of a workspace', () => {
  test('is when the newest ios, android or macos run finished, ignoring dev server use', () => {
    const state = {
      lastUsedAt: '2026-09-10T00:00:00Z',
      supervisor: { startedAt: '2026-09-10T00:00:00Z' },
      lastIosBuild: { platform: 'ios', status: 'success', startedAt: '2026-09-01T00:00:00Z', durationMs: 0 },
      buildHistory: {
        macos: [{ platform: 'macos', status: 'success', startedAt: '2026-09-05T00:00:00Z', durationMs: 60_000 }],
      },
    };
    expect(lastNativeUseFrom(state)).toBe(Date.parse('2026-09-05T00:01:00Z'));
    expect(lastNativeUseFrom({ lastUsedAt: '2026-09-10T00:00:00Z' })).toBeNaN();
  });
});

describe('last build per platform', () => {
  const ios = {
    platform: 'ios',
    fingerprint: 'abc',
    cacheHit: 'remote',
    cacheSkipped: false,
    durationMs: 42_000,
    startedAt: '2026-09-25T10:00:00.000Z',
    status: 'ok',
  };

  test('a failed build reports its first diagnostics, positioned ones first, bounded, and drops malformed ones', () => {
    const diagnostics = [
      { file: '/app/ios/App/AppDelegate.swift', line: 71, column: 24, message: 'cannot convert value', remedy: 'x' },
      { message: 'linker command failed', line: 0 },
      { file: 'a', line: 1 },
      { file: 'a', line: -2, message: 'b' },
      ...Array.from({ length: 6 }, (_, i) => ({ message: `m${i}` })),
    ];
    const failed = { ...ios, cacheHit: false, status: 'failed', errorCode: 'STIM_BUILD_FAILED', diagnostics };
    expect(readLastBuilds({ lastBuild: failed }).ios?.diagnostics).toEqual([
      { file: '/app/ios/App/AppDelegate.swift', line: 71, column: 24, message: 'cannot convert value' },
      { file: 'a', line: null, column: null, message: 'b' },
      { file: null, line: null, column: null, message: 'linker command failed' },
      { file: null, line: null, column: null, message: 'm0' },
      { file: null, line: null, column: null, message: 'm1' },
    ]);
    expect(readLastBuilds({ lastBuild: { ...ios, diagnostics } }).ios).not.toHaveProperty('diagnostics');
  });

  test('a miss reason is reported for a compiled run, bounded, and dropped from a cache hit', () => {
    const missReason = {
      kind: 'changed',
      summary: 'native dependency added: expo-clipboard',
      changes: [
        ...Array.from({ length: 25 }, (_, i) => ({ source: `f${i}`, change: 'changed', category: 'file' })),
        { source: 'bad', change: 'renamed' },
      ],
      changeCount: 40,
      baseline: { fingerprint: 'old', from: 'elsewhere' },
      rekeyedBy: ['prebuild', 3],
    };
    const compiled = readLastBuilds({ lastBuild: { ...ios, cacheHit: false, missReason } }).ios?.missReason;
    expect(compiled).toMatchObject({ kind: 'changed', changeCount: 40, baseline: null, rekeyedBy: ['prebuild'] });
    expect(compiled?.changes).toHaveLength(20);
    expect(readLastBuilds({ lastBuild: { ...ios, missReason } }).ios?.missReason).toBeUndefined();
    expect(
      readLastBuilds({ lastBuild: { ...ios, cacheHit: false, missReason: { kind: 'bogus', summary: 'x' } } }).ios
        ?.missReason,
    ).toBeUndefined();
  });
});

describe('build history per platform', () => {
  const entry = (startedAt: string, extra: Record<string, unknown> = {}) => ({
    platform: 'ios',
    status: 'ok',
    result: 'succeeded',
    startedAt,
    durationMs: 1000,
    cacheHit: false,
    ...extra,
  });

  test('an entry without a known result takes it from its status', () => {
    const history = readBuildHistory({
      buildHistory: { ios: [entry('2026-09-20T00:00:00Z', { status: 'failed', result: 'exploded' })] },
    });
    expect(history.ios![0]!.result).toBe('failed');
  });
});
