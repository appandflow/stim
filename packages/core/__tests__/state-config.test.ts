import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConcurrencyLimits, getParkedMax, loadConfig } from '../state/config.ts';

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
