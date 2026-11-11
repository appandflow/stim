import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRunnerHome, writeClaudeGuidance } from './runner.mjs';
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

const skill = (dir, name) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}`);
};

const missing = (platform, scenario, arm, pins) => benchmarkCell(platform, scenario, arm, pins).missing.join('; ');

describe('benchmark matrix', () => {
  it('runs the generated standalone cells without setup', () => {
    for (const [platform, scenario] of [
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

  it('keeps a cell blocked until the pins it needs are set, and names them with its blockers', () => {
    expect(missing('bare-ios', 'launch', 'stim')).toMatch(/stim-benchmarks commit with the bare/);
    expect(missing('bare-ios', 'launch', 'stim', { FIXTURES_COMMIT: 'abc' })).not.toMatch(/stim-benchmarks commit/);
    expect(missing('bare-ios', 'launch', 'stim', { FIXTURES_COMMIT: 'abc' })).toMatch(/#5511/);
    expect(() => assertRunnableCell('exact-ios', 'error-fix', 'control', {})).toThrow(/exact fixture/);
    expect(missing('expo-ios', 'launch', 'expo-agent-cli')).toMatch(/@expo\/agent-cli version/);
    expect(
      missing('expo-ios', 'launch', 'expo-agent-cli', {
        FIXTURES_COMMIT: 'abc',
        EXPO_AGENT_CLI_VERSION: '1.0.27',
        EXPO_AGENT_CLI_INTEGRITY: 'sha512-x',
        EXPO_SKILLS_SHA256: 'x',
      }),
    ).not.toMatch(/agent-cli|Expo skills|stim-benchmarks commit/);
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

  it('installs each skill of the Expo skills plugin as its own skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-bench-arm-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'auth.json'), '{}');
    skill(join(root, 'skills'), 'agent-device');
    skill(join(root, 'expo'), 'expo-router');
    skill(join(root, 'expo'), 'expo-dev-client');
    writeFileSync(join(root, 'expo', 'README.md'), 'not a skill');
    const runDir = join(root, 'run');
    const { codexHome, skillNames } = makeRunnerHome({
      runDir,
      arm: 'expo-agent-cli',
      codexAuthPath: join(root, 'auth.json'),
      agentSkillsRoot: join(root, 'skills'),
      stimPackage: root,
      expoSkillsRoot: join(root, 'expo'),
    });
    expect(skillNames).toEqual(['agent-device', 'expo-dev-client', 'expo-router']);
    const guidance = readFileSync(writeClaudeGuidance(codexHome, runDir).path, 'utf8');
    expect(guidance).toContain('# expo-router');
    expect(guidance).toContain('# expo-dev-client');
  });
});
