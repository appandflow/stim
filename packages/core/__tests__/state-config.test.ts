import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConcurrencyLimits, getRepoSettings, loadConfig, withConfigLock } from '../state/config.ts';

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

test('loadConfig returns null when no file exists', () => {
  expect(loadConfig()).toBe(null);
});

test('loadConfig reports a corrupt config by path instead of throwing a raw SyntaxError', () => {
  writeFileSync(join(tmpHome, 'config.json'), '{"projects": {"/a": ');
  let err: unknown;
  try {
    loadConfig();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/not valid JSON/);
  expect((err as Error).message).toMatch(/config\.json/);
  expect((err as Error).constructor.name).not.toMatch(/SyntaxError/);
});

test('loadConfig keeps a corrupt config on disk rather than resetting it', () => {
  const p = join(tmpHome, 'config.json');
  writeFileSync(p, 'not json at all');
  expect(() => loadConfig()).toThrow(/not valid JSON/);
  expect(readFileSync(p, 'utf-8')).toBe('not json at all');
});

test('withConfigLock releases the lock when the body throws', () => {
  expect(() =>
    withConfigLock(() => {
      throw new Error('boom');
    }),
  ).toThrow(/boom/);
  expect(existsSync(join(tmpHome, 'config.lock'))).toBe(false);
  expect(withConfigLock(() => 'ok')).toBe('ok');
});

test('getRepoSettings returns an empty object for an unknown repo', () => {
  expect(getRepoSettings('/nope/.git')).toEqual({});
});

test('getConcurrencyLimits is unlimited (0) when nothing is set', () => {
  const env = {};
  expect(getConcurrencyLimits({ env })).toEqual({ maxBuilds: 0, maxDevices: 0 });
});

test('getConcurrencyLimits reads config.json concurrency', () => {
  writeConfig({ version: 2, projects: {}, repos: {}, concurrency: { maxBuilds: 2, maxDevices: 3 } });
  expect(getConcurrencyLimits({ env: {} })).toEqual({ maxBuilds: 2, maxDevices: 3 });
});

test('env overrides config, and 0/absent means no enforcement', () => {
  writeConfig({ version: 2, projects: {}, repos: {}, concurrency: { maxBuilds: 2, maxDevices: 3 } });
  expect(getConcurrencyLimits({ env: { STIM_MAX_BUILDS: '5', STIM_MAX_DEVICES: '0' } })).toEqual({
    maxBuilds: 5,
    maxDevices: 0,
  });
});

test('a negative or garbage value reads as unlimited', () => {
  expect(getConcurrencyLimits({ env: { STIM_MAX_BUILDS: '-1', STIM_MAX_DEVICES: 'lots' } })).toEqual({
    maxBuilds: 0,
    maxDevices: 0,
  });
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
