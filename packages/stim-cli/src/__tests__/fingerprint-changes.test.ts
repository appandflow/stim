import { describe, expect, test } from 'vitest';
import { configInputsChanged, inputsChangedDuringBuild } from '../fingerprint/changes.ts';
import type { Fingerprint } from '../fingerprint/evaluate.ts';

function value(config: Record<string, unknown>, rows: Fingerprint['inputs']): Fingerprint {
  return {
    schema: 2,
    hash: 'hash',
    platform: 'ios',
    native: 'generated',
    inputs: rows,
    nativePackages: [],
    configModules: ['plugin.js'],
    config,
    portable: true,
    opaque: [],
    from: 'evaluated',
    fingerprintConfigKeys: [],
  };
}

const row = (name: string, hash: string): Fingerprint['inputs'][number] => ({ name, kind: 'file', hash });

describe('native fingerprint changes', () => {
  test('allows prebuild to add a bundle identifier but detects edits to config modules', () => {
    const before = value({ name: 'app' }, [row('config', 'a'), row('plugin.js', 'a')]);
    const generated = value({ name: 'app', ios: { bundleIdentifier: 'dev.app' } }, [
      row('config', 'b'),
      row('plugin.js', 'a'),
    ]);
    expect(configInputsChanged(before, generated, { prebuildRan: true })).toEqual([]);
    if (!generated.config) throw new Error('The generated fixture has no config.');
    const edited = value(generated.config, [row('config', 'b'), row('plugin.js', 'b')]);
    expect(configInputsChanged(before, edited, { prebuildRan: true })).toEqual(['plugin.js']);
  });

  test('reports a native input changed during compilation', () => {
    const before = value({}, [row('ios/App.swift', 'a')]);
    const after = value({}, [row('ios/App.swift', 'b')]);
    expect(inputsChangedDuringBuild(before, before, after, { prebuildRan: false })).toEqual(['ios/App.swift']);
  });
});
