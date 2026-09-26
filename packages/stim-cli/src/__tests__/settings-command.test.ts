import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerSettings } from '../commands/settings.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { loadConfig, saveConfig } from '../workspace/config.ts';

let base: string;
let home: string;
let repo: string;
let app: string;
let cwd: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-settings-')));
  home = join(base, 'home');
  repo = join(base, 'repo');
  app = join(repo, 'apps', 'mobile');
  mkdirSync(home);
  mkdirSync(app, { recursive: true });
  getExecutor().runFile('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(app, 'package.json'), '{}\n');
  process.env.STIM_HOME = home;
  const real = getExecutor();
  setExecutor(
    Object.assign(Object.create(real), {
      runFileQuiet: (file: string, args: string[], opts: object) =>
        file === 'osascript' ? null : real.runFileQuiet(file, args, opts),
    }),
  );
  cwd = process.cwd();
  process.chdir(app);
  process.exitCode = undefined;
});

afterEach(() => {
  resetExecutor();
  process.chdir(cwd);
  rmSync(base, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = undefined;
});

async function settings(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const note: string[] = [];
  const program = new Command().exitOverride();
  registerSettings(program, { out: (line) => out.push(line), note: (line) => note.push(line) }, env);
  await program.parseAsync(['settings', ...args], { from: 'user' });
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { out, note, exitCode };
}

function entry(payload: { settings: Array<{ key: string }> }, key: string) {
  return payload.settings.find((setting) => setting.key === key);
}

test('--json reports each layer, the winning one, environment overrides, and defaults', async () => {
  writeFileSync(
    join(app, '.stim.json'),
    JSON.stringify({ ios: { runtime: '26.0' }, optimizations: { android: { pch: 'on' } } }),
  );
  writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktree: { defaultBranch: 'trunk' }, bogus: true }));
  await settings(['set', 'ios.runtime', '26.2', '--scope', 'repo']);
  await settings(['set', 'optimizations.android.pch', 'off', '--scope', 'machine']);
  await settings(['set', 'concurrency.maxBuilds', '4']);

  const { out, exitCode } = await settings(['--json'], { STIM_HOME: home, STIM_MAX_BUILDS: '2' });

  expect(exitCode).toBe(0);
  expect(out).toHaveLength(1);
  const payload = JSON.parse(out[0]!);
  expect(payload.project).toBe(app);
  expect(entry(payload, 'ios.runtime')).toEqual({
    key: 'ios.runtime',
    value: '26.2',
    origin: 'repo',
    layers: { repo: '26.2', committed: '26.0' },
  });
  expect(entry(payload, 'optimizations.android.pch')).toMatchObject({
    value: 'on',
    origin: 'committed',
    layers: { committed: 'on', machine: 'off' },
  });
  expect(entry(payload, 'worktree.defaultBranch')).toMatchObject({ value: 'trunk', origin: 'committed' });
  expect(entry(payload, 'concurrency.maxBuilds')).toMatchObject({
    value: 2,
    origin: 'env',
    layers: { machine: 4 },
    env: { name: 'STIM_MAX_BUILDS', value: '2' },
  });
  expect(entry(payload, 'pool.iosParkedMax')).toMatchObject({ value: 0, origin: 'env', env: { name: 'STIM_HOME' } });
  expect(entry(payload, 'metro.tunnel')).toMatchObject({ value: 'auto', origin: 'default', layers: {} });
  expect(entry(payload, 'ios.deviceType')).toMatchObject({ value: null, origin: null });
  expect(payload.unknown).toEqual([{ key: 'bogus', scope: 'committed', file: join(repo, '.stim.json'), value: true }]);
});

test('set and unset edit .stim.json in place, keeping other keys and indentation', async () => {
  const file = join(app, '.stim.json');
  writeFileSync(
    file,
    '{\n    "$schema": "https://unpkg.com/stim/dist/settings.schema.json",\n    "android": { "variant": "productionDebug" }\n}\n',
  );

  expect((await settings(['set', 'android.dataPartitionSizeGb', '12', '--scope', 'committed'])).exitCode).toBe(0);
  expect(readFileSync(file, 'utf-8')).toBe(
    '{\n    "$schema": "https://unpkg.com/stim/dist/settings.schema.json",\n    "android": {\n        "variant": "productionDebug",\n        "dataPartitionSizeGb": 12\n    }\n}\n',
  );

  await settings(['unset', 'android.variant', '--scope', 'committed']);
  await settings(['unset', 'android.dataPartitionSizeGb', '--scope', 'committed']);
  expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
    $schema: 'https://unpkg.com/stim/dist/settings.schema.json',
  });
  expect(JSON.parse((await settings(['--json'])).out[0]!).unknown).toEqual([]);
});

test('a machine write keeps the project and device records in the config', async () => {
  saveConfig({
    version: 2,
    projects: { [app]: { metroPort: 8081, platforms: { ios: { deviceUdid: 'U', owned: true } } } },
    repos: {},
  });

  await settings(['set', 'iosSimulatorApp', 'stim-desktop']);
  await settings(['set', 'ios.deviceType', 'iPhone 17 Pro', '--scope', 'workspace']);

  const config = loadConfig();
  expect(config?.iosSimulatorApp).toBe('stim-desktop');
  expect(config?.projects[app]).toEqual({
    metroPort: 8081,
    platforms: { ios: { deviceUdid: 'U', owned: true } },
    settings: { ios: { deviceType: 'iPhone 17 Pro' } },
  });
});

test("run from a monorepo web package, settings act on the worktree's one registered app", async () => {
  const web = join(repo, 'apps', 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'package.json'), JSON.stringify({ devDependencies: { vite: '^5.0.0' } }));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '^57.0.0' } }));
  saveConfig({ version: 2, projects: { [app]: {} }, repos: {} });
  process.chdir(web);

  const set = await settings(['set', 'web.url', 'https://localhost:{port:web}/apps/', '--scope', 'workspace']);
  await settings(['set', 'web.viewport', 'phone', '--scope', 'committed']);

  expect(set.exitCode).toBe(0);
  expect(set.note).toContain(`Using the Stim workspace ${app}: ${web} is not a React Native or Expo app.`);
  expect(loadConfig()?.projects).toEqual({
    [app]: { settings: { web: { url: 'https://localhost:{port:web}/apps/' } } },
  });
  expect(JSON.parse(readFileSync(join(app, '.stim.json'), 'utf-8'))).toEqual({ web: { viewport: 'phone' } });
  expect(existsSync(join(web, '.stim.json'))).toBe(false);
});

test('the viewer settings default to stim-desktop while Stim Desktop is installed on macOS, and a set value wins', async () => {
  const stubbed = getExecutor();
  let desktop = '/Applications/Stim.app';
  setExecutor(
    Object.assign(Object.create(stubbed), {
      runFileQuiet: (file: string, args: string[], opts: object) =>
        file === 'osascript' ? desktop : stubbed.runFileQuiet(file, args, opts),
    }),
  );
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    expect(await settings(['get', 'iosSimulatorApp'])).toMatchObject({
      out: ['stim-desktop'],
      note: ['(default: Stim Desktop installed)'],
    });
    const payload = JSON.parse((await settings(['--json'])).out[0]!);
    expect(entry(payload, 'androidEmulatorApp')).toEqual({
      key: 'androidEmulatorApp',
      value: 'stim-desktop',
      origin: 'default',
      layers: {},
      defaultReason: 'Stim Desktop installed',
    });
    expect((await settings([])).out).toContainEqual(
      expect.stringMatching(/^iosSimulatorApp +stim-desktop {2}\(default: Stim Desktop installed\)$/),
    );

    writeFileSync(join(home, 'config.json'), JSON.stringify({ iosSimulatorApp: 'xcode' }));
    expect(await settings(['get', 'iosSimulatorApp'])).toMatchObject({ out: ['xcode'], note: [] });

    desktop = '';
    expect(await settings(['get', 'androidEmulatorApp'])).toMatchObject({ out: ['emulator'], note: [] });
  } finally {
    vi.restoreAllMocks();
  }
});

test('a command run by Stim Desktop reports the Desktop viewer default without the Launch Services lookup', async () => {
  const stubbed = getExecutor();
  setExecutor(
    Object.assign(Object.create(stubbed), {
      runFileQuiet: (file: string, args: string[], opts: object) => {
        if (file === 'osascript') throw new Error('Launch Services lookup ran');
        return stubbed.runFileQuiet(file, args, opts);
      },
    }),
  );
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    const payload = JSON.parse((await settings(['--json'], { STIM_DESKTOP_APP: '/Applications/Stim.app' })).out[0]!);
    expect(entry(payload, 'iosSimulatorApp')).toMatchObject({
      value: 'stim-desktop',
      defaultReason: 'Stim Desktop installed',
    });
  } finally {
    vi.restoreAllMocks();
  }
});

test.each([
  [
    ['set', 'android.dataPartitionSizeGb', '5', '--scope', 'workspace'],
    'Expected a whole number from 6 through 16384.',
  ],
  [
    ['set', 'metro.tunnel', 'wormhole', '--scope', 'workspace'],
    'Expected one of: auto, off, expo, cloudflared, ngrok.',
  ],
  [['set', 'worktree.exclude', 'node_modules', '--scope', 'repo'], 'Expected an array of strings, written as JSON.'],
  [
    ['set', 'worktree.exclude', '["a"]', '--scope', 'workspace'],
    'worktree.exclude is not read from the workspace layer.',
  ],
  [['set', 'ios.runtime', '26.2'], 'needs --scope'],
  [['set', 'ios.nope', '1', '--scope', 'workspace'], '"ios.nope" is not a Stim setting.'],
  [['set', 'android.keystorePassword', 'hunter2', '--scope', 'committed'], 'only an env: or file: reference'],
])('%j refuses with STIM_BAD_ARG, one JSON payload, and no write', async (args, message) => {
  const { out, exitCode } = await settings([...args, '--json']);

  expect(exitCode).toBe(1);
  expect(out).toHaveLength(1);
  const failure = JSON.parse(out[0]!);
  expect(failure.code).toBe('STIM_BAD_ARG');
  expect(failure.message).toContain(message);
  expect(loadConfig()).toBeNull();
  expect(existsSync(join(app, '.stim.json'))).toBe(false);
});

test('a sensitive value is masked in every output while the layer keeps the real value', async () => {
  await settings(['set', 'android.keystorePassword', 'hunter2', '--scope', 'repo']);

  const plain = await settings(['get', 'android.keystorePassword']);
  const json = await settings(['--json']);
  const listing = await settings([]);

  expect(plain.out).toEqual(['********']);
  expect(entry(JSON.parse(json.out[0]!), 'android.keystorePassword')).toMatchObject({
    value: '********',
    layers: { repo: '********' },
    sensitive: true,
  });
  for (const output of [plain.out, json.out, listing.out]) expect(output.join('\n')).not.toContain('hunter2');
  expect(JSON.stringify(loadConfig()?.repos)).toContain('hunter2');
});

test('an environment-provided value is reported through the registry type, not as the raw string', async () => {
  const env = { STIM_HOME: home, STIM_BUDGET_MIN_FREE_DISK_GB: '40' };

  const json = await settings(['--json'], env);
  const get = await settings(['get', 'budget.minFreeDiskGb', '--json'], env);

  expect(entry(JSON.parse(json.out[0]!), 'budget.minFreeDiskGb')).toMatchObject({
    value: 40,
    origin: 'env',
    env: { name: 'STIM_BUDGET_MIN_FREE_DISK_GB', value: '40' },
  });
  expect(JSON.parse(get.out[0]!)).toMatchObject({ value: 40, origin: 'env' });
});

test('an invalid environment value refuses with STIM_BAD_ARG, like an invalid `settings set` value', async () => {
  const env = { STIM_HOME: home, STIM_BUDGET_MIN_FREE_DISK_GB: 'lots' };

  const json = await settings(['--json'], env);
  const get = await settings(['get', 'budget.minFreeDiskGb', '--json'], env);

  for (const { exitCode, out } of [json, get]) {
    expect(exitCode).toBe(1);
    expect(out).toHaveLength(1);
    const failure = JSON.parse(out[0]!);
    expect(failure.code).toBe('STIM_BAD_ARG');
    expect(failure.message).toBe('Invalid STIM_BUDGET_MIN_FREE_DISK_GB value "lots". Expected a number, 0 or more.');
  }
});
