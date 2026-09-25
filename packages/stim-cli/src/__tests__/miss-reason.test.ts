import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FingerprintSource } from '@expo/fingerprint';
import type { WorkspaceState } from '@stim-cli/core/state';
import type { SourceChange } from '../cache/build-cache.ts';
import { findMissBaseline, missReasonFromChanges, projectIdentity } from '../cache/miss-reason.ts';

const baseline = { fingerprint: 'old', from: 'workspace' as const };

describe('missReasonFromChanges', () => {
  test('an added native module leads the summary over the autolinking config it also changed', () => {
    const changes: SourceChange[] = [
      { name: 'expoAutolinkingConfig:ios', change: 'changed', reasons: ['expoAutolinkingIos'] },
      { name: 'node_modules/expo-clipboard/ios', change: 'added', reasons: ['expoAutolinkingIos'] },
    ];
    const reason = missReasonFromChanges({ changes, baseline });
    expect(reason.kind).toBe('changed');
    expect(reason.summary).toBe('native dependency added: expo-clipboard');
    expect(reason.changes).toEqual([
      { source: 'node_modules/expo-clipboard/ios', change: 'added', category: 'native-dependency' },
      { source: 'expoAutolinkingConfig:ios', change: 'changed', category: 'autolinking' },
    ]);
    expect(reason.changeCount).toBe(2);
  });

  test('names the app config, scoped packages, config plugins, patches and bare native dirs', () => {
    const summary = (change: SourceChange) => missReasonFromChanges({ changes: [change], baseline }).summary;
    expect(summary({ name: 'expoConfig', change: 'changed', reasons: ['expoConfig'] })).toBe('app config changed');
    expect(summary({ name: 'node_modules/@expo/ui/ios', change: 'removed', reasons: ['expoAutolinkingIos'] })).toBe(
      'native dependency removed: @expo/ui',
    );
    expect(
      summary({ name: 'node_modules/react-native-screens', change: 'changed', reasons: ['rncoreAutolinkingIos'] }),
    ).toBe('native dependency changed: react-native-screens');
    expect(
      summary({ name: 'node_modules/expo-camera/app.plugin.js', change: 'changed', reasons: ['expoConfigPlugins'] }),
    ).toBe('config plugin changed: expo-camera');
    expect(summary({ name: 'patches', change: 'changed', reasons: ['patchPackage'] })).toBe('patches changed');
    expect(summary({ name: 'ios', change: 'changed', reasons: ['bareNativeDir'] })).toBe('ios/ changed');
    expect(summary({ name: 'package:react-native', change: 'changed', reasons: ['package:react-native'] })).toBe(
      'react-native changed',
    );
  });

  test('keeps at most 20 changes but counts them all, and repeats of one label count once', () => {
    const changes: SourceChange[] = Array.from({ length: 30 }, (_, i) => ({
      name: `node_modules/expo-splash-screen/plugin/build/file-${i}.js`,
      change: 'changed',
      reasons: ['expoConfigPlugins'],
    }));
    const reason = missReasonFromChanges({ changes, baseline });
    expect(reason.changes).toHaveLength(20);
    expect(reason.changeCount).toBe(30);
    expect(reason.summary).toBe('config plugin changed: expo-splash-screen');
  });

  test('says when there is nothing to compare, when the sources match, and when prebuild moved the key', () => {
    expect(missReasonFromChanges({ changes: [], baseline: null })).toMatchObject({
      kind: 'no-baseline',
      baseline: null,
    });
    expect(missReasonFromChanges({ changes: [], baseline }).kind).toBe('same-sources');
    const rekeyed = missReasonFromChanges({
      changes: [{ name: 'expoConfig', change: 'changed', reasons: ['expoConfig'] }],
      baseline,
      rekeyedBy: ['prebuild', 'pod install'],
    });
    expect(rekeyed.summary).toBe('prebuild and pod install changed native inputs; app config changed');
    expect(rekeyed.rekeyedBy).toEqual(['prebuild', 'pod install']);
  });
});

describe('findMissBaseline', () => {
  const sources: FingerprintSource[] = [{ type: 'file', filePath: 'ios/Podfile.lock', reasons: [], hash: 'aa' }];
  const build = (cacheKey: string, startedAt: string, platform = 'ios') => ({
    platform,
    fingerprint: cacheKey.split('-')[0],
    cacheKey,
    startedAt,
  });

  function deps(states: Record<string, WorkspaceState>, stored: Record<string, FingerprintSource[]>) {
    return {
      readState: (root: string) => states[root] ?? null,
      projectRoots: () => Object.keys(states),
      identity: (root: string) => (root.startsWith('/other') ? 'other-project' : 'project'),
      sourcesOf: (_platform: string, key: string) => stored[key] ?? null,
    };
  }

  test("prefers this workspace's last build of the same platform", () => {
    const states = {
      '/wt/a': { lastIosBuild: build('own-debug-sim', '2026-09-01T00:00:00Z') },
      '/wt/b': { lastIosBuild: build('newer-debug-sim', '2026-09-20T00:00:00Z') },
    };
    const found = findMissBaseline(
      '/wt/a',
      'ios',
      deps(states, { 'own-debug-sim': sources, 'newer-debug-sim': sources }),
    );
    expect(found).toMatchObject({ fingerprint: 'own', from: 'workspace' });
  });

  test('falls back to the newest build of the same project that still has its sources', () => {
    const states = {
      '/wt/a': { lastBuild: build('gone-debug', '2026-09-21T00:00:00Z', 'android') },
      '/wt/b': { lastIosBuild: build('older-debug-sim', '2026-09-10T00:00:00Z') },
      '/wt/c': { lastIosBuild: build('pruned-debug-sim', '2026-09-22T00:00:00Z') },
      '/other/d': { lastIosBuild: build('unrelated-debug-sim', '2026-09-23T00:00:00Z') },
      '/wt/e': { lastAndroidBuild: build('android-debug', '2026-09-24T00:00:00Z', 'android') },
    };
    const found = findMissBaseline(
      '/wt/a',
      'ios',
      deps(states, {
        'older-debug-sim': sources,
        'unrelated-debug-sim': sources,
        'android-debug': sources,
        'gone-debug': sources,
      }),
    );
    expect(found).toMatchObject({ fingerprint: 'older', from: 'project' });
    expect(findMissBaseline('/wt/a', 'ios', deps({ '/wt/a': {} }, {}))).toBe(null);
  });
});

describe('projectIdentity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-miss-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('two worktrees of one repository agree on the same app, and differ from another app in it', () => {
    const main = join(dir, 'main');
    const linked = join(dir, 'linked');
    mkdirSync(join(main, '.git', 'worktrees', 'linked'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'linked', 'commondir'), '../..\n');
    mkdirSync(join(linked, 'apps', 'mobile'), { recursive: true });
    writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'linked')}\n`);
    mkdirSync(join(main, 'apps', 'mobile'), { recursive: true });
    mkdirSync(join(main, 'apps', 'web'), { recursive: true });

    const mobile = projectIdentity(join(main, 'apps', 'mobile'));
    expect(mobile).not.toBe(null);
    expect(projectIdentity(join(linked, 'apps', 'mobile'))).toBe(mobile);
    expect(projectIdentity(join(main, 'apps', 'web'))).not.toBe(mobile);
    expect(projectIdentity(join(dir, 'missing'))).toBe(null);
  });
});
