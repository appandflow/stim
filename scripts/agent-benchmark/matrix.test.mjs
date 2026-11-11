import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRunnerHome } from './runner.mjs';
import {
  assertRunnableCell,
  BENCHMARK_MODEL_PIN,
  benchmarkCell,
  benchmarkMatrix,
  assertCampaignModel,
  campaignModels,
  scenarioForVariant,
} from './matrix.mjs';

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('benchmark matrix', () => {
  it('runs the Expo and standalone cells for control and Stim without further setup', () => {
    for (const [platform, scenario] of [
      ['expo-ios', 'launch'],
      ['expo-android', 'native-change'],
      ['expo-android', 'error-fix'],
      ['macos', 'launch'],
      ['native-ios', 'error-fix'],
    ]) {
      for (const arm of ['control', 'stim'])
        expect(assertRunnableCell(platform, scenario, arm).status).toBe('runnable');
    }
  });

  it('gives native change to the React Native rows only', () => {
    expect(benchmarkCell('bare-android', 'native-change', 'stim').status).toBe('not-yet-runnable');
    for (const platform of ['macos', 'native-ios', 'native-android', 'exact-ios']) {
      expect(benchmarkCell(platform, 'native-change', 'stim').status).toBe('not-applicable');
    }
    expect(scenarioForVariant('native', 'readiness')).toBe('native-change');
    expect(() => scenarioForVariant('native', 'native')).toThrow(/unsupported variant/);
  });

  it('keeps a cell blocked until the pins it needs are set, and names them', () => {
    expect(() => assertRunnableCell('bare-ios', 'launch', 'stim')).toThrow(/bare React Native fixture/);
    expect(assertRunnableCell('bare-ios', 'launch', 'stim', { BARE_FIXTURE_COMMIT: 'abc' }).status).toBe('runnable');
    expect(() => assertRunnableCell('exact-ios', 'error-fix', 'control', {})).toThrow(/Exact fixture/);
    expect(() => assertRunnableCell('expo-ios', 'launch', 'expo-agent-cli')).toThrow(/@expo\/agent-cli version/);
    expect(
      assertRunnableCell('expo-ios', 'launch', 'expo-agent-cli', {
        EXPO_AGENT_CLI_VERSION: '1.0.27',
        EXPO_AGENT_CLI_INTEGRITY: 'sha512-x',
        EXPO_SKILLS_SHA256: 'x',
      }).status,
    ).toBe('runnable');
  });

  it('has no web row and gives the Expo tool arm only Expo platforms', () => {
    const covered = new Set(
      benchmarkMatrix()
        .filter((cell) => cell.arm === 'expo-agent-cli' && cell.status !== 'unsupported')
        .map((cell) => cell.platform),
    );
    expect([...covered].toSorted()).toEqual(['expo-android', 'expo-ios']);
    expect(benchmarkMatrix().some((cell) => cell.platform === 'web')).toBe(false);
    expect(benchmarkCell('bare-ios', 'launch', 'expo-agent-cli').status).toBe('unsupported');
  });

  it('keeps the model an axis whose campaign list defaults to Sonnet only', () => {
    expect(campaignModels({})).toEqual([BENCHMARK_MODEL_PIN]);
    expect(campaignModels({ MODELS: 'claude-sonnet-5-5, gpt-5.6-sol' })).toEqual(['claude-sonnet-5-5', 'gpt-5.6-sol']);
    expect(() => assertCampaignModel('gpt-5.6-sol', {})).toThrow(/campaign's model list/);
  });

  it('refuses to build a runner home for an arm whose skill has no configured source', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-bench-arm-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'auth.json'), '{}');
    expect(() =>
      makeRunnerHome({
        runDir: join(root, 'run'),
        arm: 'expo-agent-cli',
        codexAuthPath: join(root, 'auth.json'),
        agentSkillsRoot: root,
        stimPackage: root,
      }),
    ).toThrow(/expo-skills/);
  });
});
