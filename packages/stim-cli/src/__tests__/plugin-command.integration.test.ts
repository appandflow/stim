import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runCli } from '../cli/define-op.ts';
import plugin from '../commands/plugin.ts';

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
    api: { 'cache-provider': 1, transport: 1, 'agent-driver': 1 },
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
