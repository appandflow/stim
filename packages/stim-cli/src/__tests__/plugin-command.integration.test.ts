import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runCli } from '../cli/define-op.ts';
import plugin from '../commands/plugin.ts';
import { pluginRefFindings } from '../plugin-refs.ts';
import { readSettingsContext } from '../workspace/settings-payload.ts';

const fixtures = fileURLToPath(new URL('../../../../test/fixtures/plugins', import.meta.url));

let base: string;
let cwd: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-plugin-command-')));
  mkdirSync(join(base, 'home'));
  process.env.STIM_HOME = join(base, 'home');
  cwd = process.cwd();
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(base, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function stim(args: string[], dir: string): Promise<{ payload: unknown; exitCode: number }> {
  process.chdir(dir);
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await runCli(plugin, args, { version: '9.9.9' });
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  expect(out).toHaveLength(1);
  return { payload: JSON.parse(out.join('')), exitCode };
}

test('plugin test passes a fixture, fails its stim-importing twin, and refuses a kind it does not run', async () => {
  const passing = await stim(['test', 'transport-fixture', '--json'], fixtures);
  expect(passing).toMatchObject({ exitCode: 0, payload: { kinds: { transport: 1 }, passed: true } });

  const twin = await stim(['test', '.', '--json'], join(fixtures, 'driver-fixture-imports-stim'));
  expect(twin).toMatchObject({
    exitCode: 1,
    payload: { passed: false, checks: [{ kind: 'agent-driver', name: 'the module loads', passed: false }] },
  });

  writeFileSync(
    join(base, 'package.json'),
    JSON.stringify({ name: 'provider', main: 'index.mjs', stimPlugin: { kinds: { 'cache-provider': 1 } } }),
  );
  writeFileSync(join(base, 'index.mjs'), 'throw new Error("plugin test imported a cache provider");\n');
  expect(await stim(['test', '.', '--json'], base)).toEqual({
    exitCode: 1,
    payload: { code: 'STIM_BAD_ARG', message: expect.stringContaining('(cache-provider)'), remedy: expect.any(String) },
  });
});

test('plugin list names the bundled plugins and a cache provider it cannot load', async () => {
  const app = join(base, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '*' } }));
  writeFileSync(join(app, '.stim.json'), JSON.stringify({ cache: { provider: 'missing-provider' } }));
  const { payload, exitCode } = await stim(['list', '--json'], app);
  expect(exitCode).toBe(0);
  expect(payload).toEqual({
    api: { 'cache-provider': 1, transport: 1, 'agent-driver': 1, project: 1 },
    plugins: [
      expect.objectContaining({ name: 'builtin:local', kinds: { transport: 1 }, accepted: true }),
      expect.objectContaining({ name: 'builtin:tailscale', kinds: { transport: 1 }, accepted: true }),
      expect.objectContaining({ name: 'builtin:agent-device', kinds: { 'agent-driver': 1 }, accepted: true }),
      {
        name: 'missing-provider',
        source: 'project',
        kinds: {},
        selectedBy: ['cache.provider'],
        accepted: false,
        reason: expect.stringContaining('does not resolve'),
        baseDir: app,
      },
    ],
  });
});

test('a project plugin with no entry module is listed, tested and reported from its package.json alone', async () => {
  const manifest = (project: unknown) =>
    JSON.stringify({ name: 'stim-plugin-godot', stimPlugin: { kinds: { project: 1 }, project } });
  const good = join(base, 'godot');
  const taken = join(base, 'taken');
  mkdirSync(good);
  mkdirSync(taken);
  writeFileSync(join(good, 'package.json'), manifest({ id: 'godot', name: 'Godot', markers: ['project.godot'] }));
  writeFileSync(join(taken, 'package.json'), manifest({ id: 'react-native', name: 'Mine', markers: ['mine.cfg'] }));
  writeFileSync(join(base, 'home', 'config.json'), JSON.stringify({ plugins: [good, taken] }));

  const { payload } = await stim(['list', '--json'], base);
  expect(payload).toEqual({
    api: expect.any(Object),
    plugins: [
      expect.objectContaining({ source: 'builtin' }),
      expect.objectContaining({ source: 'builtin' }),
      expect.objectContaining({ source: 'builtin' }),
      { name: good, source: 'machine', kinds: { project: 1 }, selectedBy: ['plugins'], accepted: true },
      {
        name: taken,
        source: 'machine',
        kinds: { project: 1 },
        selectedBy: ['plugins'],
        accepted: false,
        reason: expect.stringContaining('"react-native" is the id of a project integration Stim bundles'),
      },
    ],
  });

  const settings = await readSettingsContext(base, process.env);
  expect(await pluginRefFindings({ ...settings, projectPath: base })).toEqual([
    expect.objectContaining({
      code: 'plugin-ref',
      title: `plugins names ${taken}, which this Stim cannot load`,
      fix: expect.stringContaining('stim settings set plugins'),
    }),
  ]);

  expect(await stim(['test', '.', '--json'], good)).toMatchObject({
    exitCode: 0,
    payload: { kinds: { project: 1 }, skipped: [], passed: true },
  });
  expect(await stim(['test', taken, '--json'], base)).toMatchObject({
    exitCode: 1,
    payload: {
      passed: false,
      checks: expect.arrayContaining([
        { kind: 'project', name: 'stimPlugin.project.id is not taken', passed: false, error: expect.any(String) },
      ]),
    },
  });
});

test('a directory with no entry module is read directly only when it declares the project kind', async () => {
  const transport = join(base, 'transport');
  mkdirSync(transport);
  writeFileSync(
    join(transport, 'package.json'),
    JSON.stringify({ name: 'transport', stimPlugin: { kinds: { transport: 1 } } }),
  );
  expect(await stim(['test', transport, '--json'], base)).toEqual({
    exitCode: 1,
    payload: { code: 'STIM_BAD_ARG', message: expect.stringContaining('does not resolve'), remedy: expect.any(String) },
  });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'plugin list reports a plugins entry it cannot read instead of failing',
  async () => {
    const locked = join(base, 'locked');
    mkdirSync(locked);
    writeFileSync(join(base, 'home', 'config.json'), JSON.stringify({ plugins: [locked] }));
    chmodSync(locked, 0o000);
    try {
      const { payload, exitCode } = await stim(['list', '--json'], base);
      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({
        plugins: expect.arrayContaining([
          {
            name: locked,
            source: 'machine',
            kinds: {},
            selectedBy: ['plugins'],
            accepted: false,
            reason: expect.stringContaining('has no readable package.json: EACCES'),
          },
        ]),
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  },
);

test('a plugin under test sees only its scratch environment, and its output never reaches stdout', () => {
  const cli = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));
  const scratchRoot = join(base, 'tmp');
  mkdirSync(scratchRoot);
  const run = spawnSync(process.execPath, [cli, 'plugin', 'test', 'noisy-fixture', '--json'], {
    cwd: fixtures,
    env: { ...process.env, TMPDIR: scratchRoot, STIM_HOME: join(base, 'home'), STIM_SECRET_TOKEN: 'not for plugins' },
    encoding: 'utf8',
  });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ reference: 'noisy-fixture', passed: true });
  expect(run.stderr).toContain('noisy-fixture loaded');
  const seen = JSON.parse(/noisy-fixture env (\{.*\})/.exec(run.stderr)?.[1] ?? '{}');
  expect(Object.keys(seen).toSorted()).toEqual(['HOME', 'PATH', 'STIM_AGENT_DEVICE_BIN', 'STIM_HOME']);
  for (const value of Object.values(seen)) expect(value).toContain(join(scratchRoot, 'stim-plugin-test-'));
});
