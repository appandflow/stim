import type { FingerprintSource } from '@expo/fingerprint';
import type { WorkspaceState } from '@stim-cli/core/state';
import type { SourceChange } from '../cache/build-cache.ts';
import { findMissBaseline, missReasonFromChanges } from '../cache/miss-reason.ts';

const baseline = { fingerprint: 'old', from: 'workspace' as const };

describe('missReasonFromChanges', () => {
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
