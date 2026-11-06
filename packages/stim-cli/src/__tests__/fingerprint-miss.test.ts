import { describe, expect, test } from 'vitest';
import type { WorkspaceState } from '@stim-cli/core/state';
import { FINGERPRINT_SCHEMA, type Input } from '../fingerprint/key.ts';
import { explainBuildMiss } from '../fingerprint/miss.ts';

const row = (name: string, kind: Input['kind'], hash: string): Input => ({ name, kind, hash });
const before = [
  row('config', 'config', 'a'),
  row('env:APP_TOKEN', 'env', 'a'),
  row('ios/App/AppDelegate.swift', 'file', 'a'),
  row('ios/App/Info.plist', 'file', 'a'),
  row('package:react-native', 'package', 'a'),
];

function explain(stored: unknown, current: Input[]) {
  const state = { lastIosBuild: { platform: 'ios', fingerprint: 'old', cacheKey: 'k1', startedAt: '' } };
  return explainBuildMiss({
    root: '/app',
    platform: 'ios',
    current: { inputs: current },
    deps: {
      storedInputs: (_platform, cacheKey) => (cacheKey === 'k1' ? stored : null),
      readState: (): WorkspaceState => state,
      projectRoots: () => [],
    },
  }).reason;
}

describe('the miss explanation of the own key', () => {
  test('ranks the changes by kind, groups native files by directory and never shows an env value', () => {
    const after = [
      row('config', 'config', 'a'),
      row('env:APP_TOKEN', 'env', 'b'),
      row('ios/App/AppDelegate.swift', 'file', 'b'),
      row('ios/App/Info.plist', 'file', 'b'),
      row('package:react-native', 'package', 'b'),
    ];
    const reason = explain({ schema: FINGERPRINT_SCHEMA, hash: 'old', inputs: before }, after);
    expect(reason.kind).toBe('changed');
    expect(reason.summary).toBe('react-native changed (+2 more)');
    expect(reason.changes.map((change) => change.category)).toEqual(['package', 'native-dir', 'native-dir', 'other']);
    expect(JSON.stringify(reason)).not.toContain('"b"');
  });

  test.each([
    ['another schema', { schema: FINGERPRINT_SCHEMA + 1, inputs: before }],
    ['the source list of the key Stim used before', [{ type: 'dir', filePath: 'ios', hash: 'a', reasons: [] }]],
  ])('explains a baseline stored under %s as a one-time schema change', (_case, stored) => {
    const reason = explain(stored, before);
    expect(reason.summary).toBe("stim's fingerprint definition changed (one-time miss)");
    expect(reason.changes).toEqual([{ source: 'schema', change: 'changed', category: 'other' }]);
  });
});
