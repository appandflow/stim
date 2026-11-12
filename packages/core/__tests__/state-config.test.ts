import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SETTINGS,
  machineSettingValue,
  setSettingValueAt,
  type SettingDefinition,
} from '../state/settings-registry.ts';
import {
  derivedTestCap,
  getBootedGraceMinutes,
  getConcurrencyLimits,
  getParkedMax,
  loadConfig,
  testSlotLimit,
} from '../state/config.ts';

let tmpHome: string;

function writeConfig(config: unknown): void {
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify(config));
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('getConcurrencyLimits is unlimited (0) when nothing is set', () => {
  const env = {};
  expect(getConcurrencyLimits({ env })).toEqual({ maxBuilds: 0, maxDevices: 0 });
});

test('getConcurrencyLimits reads config.json concurrency', () => {
  writeConfig({ version: 2, projects: {}, repos: {}, concurrency: { maxBuilds: 2, maxDevices: 3 } });
  expect(getConcurrencyLimits({ env: {} })).toEqual({ maxBuilds: 2, maxDevices: 3 });
});

test.each(['ios', 'android'] as const)(
  'parked %s limits use the host config and explicit env, with scoped homes disabled',
  (platform) => {
    const envKey = platform === 'ios' ? 'STIM_POOL_IOS_PARKED_MAX' : 'STIM_POOL_ANDROID_PARKED_MAX';
    writeConfig({ version: 2, projects: {}, repos: {}, pool: { iosParkedMax: 2, androidParkedMax: 4 } });
    expect(getParkedMax(platform, { env: {} })).toEqual({ max: platform === 'ios' ? 2 : 4, error: null });
    expect(getParkedMax(platform, { env: { STIM_HOME: tmpHome } })).toEqual({ max: 0, error: null });
    expect(getParkedMax(platform, { env: { STIM_HOME: tmpHome, [envKey]: '5' } })).toEqual({ max: 5, error: null });
    expect(getParkedMax(platform, { env: { [envKey]: '-1' } })).toMatchObject({ max: 0, error: expect.any(String) });
    writeConfig({ projects: {}, repos: {} });
    expect(getParkedMax(platform, { env: { STIM_HOME: tmpHome } })).toEqual({ max: 0, error: null });
    expect(getParkedMax(platform, { env: {} })).toEqual({ max: 3, error: null });
  },
);

test('getBootedGraceMinutes defaults to 15, reads the config, and stays 0 in a scoped home unless the environment sets it', () => {
  const envKey = 'STIM_POOL_BOOTED_GRACE_MINUTES';
  expect(getBootedGraceMinutes({ env: {} })).toEqual({ max: 15, error: null });
  writeConfig({ version: 2, projects: {}, repos: {}, pool: { bootedGraceMinutes: 5 } });
  expect(getBootedGraceMinutes({ env: {} })).toEqual({ max: 5, error: null });
  expect(getBootedGraceMinutes({ env: { STIM_HOME: tmpHome } })).toEqual({ max: 0, error: null });
  expect(getBootedGraceMinutes({ env: { STIM_HOME: tmpHome, [envKey]: '2' } })).toEqual({ max: 2, error: null });
  expect(getBootedGraceMinutes({ env: { [envKey]: '1.5' } })).toMatchObject({ max: 0, error: expect.any(String) });
});

test.each([
  ['a projects container that is an array', '{ "version": 2, "projects": [] }', /projects that is not an object/],
  [
    'a project entry that is null',
    '{ "version": 2, "projects": { "/a": null } }',
    /projects entry "\/a" that is not an object/,
  ],
  [
    'a repos entry that is a string',
    '{ "version": 2, "repos": { "/r": "x" } }',
    /repos entry "\/r" that is not an object/,
  ],
])('loadConfig refuses %s instead of reading it as holding no records', (_label, content, reason) => {
  writeFileSync(join(tmpHome, 'config.json'), content);
  let err: unknown;
  try {
    loadConfig();
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string } | undefined)?.code).toBe('STIM_CONFIG_CORRUPT');
  expect((err as Error).message).toMatch(reason);
});

function configuredValue(setting: SettingDefinition): unknown {
  switch (setting.type.kind) {
    case 'boolean':
      return false;
    case 'number':
      return Math.max(setting.type.minimum ?? 0, setting.type.exclusiveMinimum ?? 0) + 1;
    case 'choice':
      return setting.type.choices[1] ?? setting.type.choices[0];
    case 'strings':
      return setting.type.kind === 'strings' && setting.type.absolutePaths ? ['/entry'] : ['entry'];
    case 'object':
      return { entry: true };
    case 'path':
      return setting.type.absolute ? '/tmp/entry' : 'entry';
    case 'bundle-url':
      return `/index.bundle?platform=${setting.key.split('.').at(-1)}`;
    case 'plugin-ref':
      return setting.type.choices?.[1] ?? 'entry';
    case 'string':
      if (setting.key === 'ios.signingIdentitySha1') return 'A'.repeat(40);
      if (setting.key === 'android.module') return ':entry';
      if (setting.key === 'share.publicUrl' || setting.key === 'web.url') return 'https://example.com';
      return 'entry';
  }
}

test.each(SETTINGS)('$key resolves its sources and registry default without losing explicit values', (setting) => {
  const value = configuredValue(setting);
  const config = {};
  setSettingValueAt(config, setting.key, value);
  expect(machineSettingValue(setting.key, { config: null, env: {} })).toEqual({ value: setting.default, error: null });
  expect(machineSettingValue(setting.key, { config, env: {} })).toEqual({ value, error: null });
  for (const [name, override] of [
    ['STIM_HOME', setting.scopedHomeValue],
    ['CI', setting.ciValue],
  ] as const) {
    const env = { [name]: '1' };
    expect(machineSettingValue(setting.key, { config, env })).toEqual({ value: override ?? value, error: null });
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const explicit = setting.env ? { [setting.env]: raw } : {};
    const overriddenConfig = {};
    setSettingValueAt(overriddenConfig, setting.key, null);
    expect(
      machineSettingValue(setting.key, {
        config: setting.env ? overriddenConfig : config,
        env: { ...env, ...explicit },
      }),
    ).toEqual({
      value: setting.env ? value : (override ?? value),
      error: null,
    });
  }
});

test.each(['bogus', '-1', '1.5'])('an invalid concurrency environment limit %s refuses before admission', (raw) => {
  writeConfig({ concurrency: { maxBuilds: 4 }, projects: {}, repos: {} });
  expect(() => getConcurrencyLimits({ env: { STIM_MAX_BUILDS: raw } })).toThrow(
    `Invalid STIM_MAX_BUILDS value ${JSON.stringify(raw)}. Expected a whole number, 0 or more.`,
  );
});

test.each([
  [4, 1],
  [6, 1],
  [10, 1],
  [12, 2],
  [14, 2],
  [24, 4],
])('the derived test cap on %i cores is %i', (cores, cap) => {
  expect(derivedTestCap(cores)).toBe(cap);
});

describe('testSlotLimit', () => {
  test('derives the cap from the cores when concurrency.maxTests is unset or 0', () => {
    expect(testSlotLimit({ env: {}, cores: 14 })).toEqual({ max: 2, derived: true });
    writeConfig({ concurrency: { maxTests: 0 }, projects: {}, repos: {} });
    expect(testSlotLimit({ env: {}, cores: 10 })).toEqual({ max: 1, derived: true });
  });

  test('STIM_MAX_TESTS overrides config.json, which overrides the derived cap', () => {
    writeConfig({ concurrency: { maxTests: 3 }, projects: {}, repos: {} });
    expect(testSlotLimit({ env: {}, cores: 14 })).toEqual({ max: 3, derived: false });
    expect(testSlotLimit({ env: { STIM_MAX_TESTS: '5' }, cores: 14 })).toEqual({ max: 5, derived: false });
  });

  test('an invalid STIM_MAX_TESTS refuses with STIM_BAD_ARG', () => {
    expect(() => testSlotLimit({ env: { STIM_MAX_TESTS: 'many' } })).toThrow(
      expect.objectContaining({ code: 'STIM_BAD_ARG' }),
    );
  });
});
