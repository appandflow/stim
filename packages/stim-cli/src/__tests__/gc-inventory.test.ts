import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { collectInventory } from '../commands/gc/inventory.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-gc-inventory-'));
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});

afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function context(name: string, env: NodeJS.ProcessEnv = {}): StimContext {
  const home = join(root, name);
  const baseEnv = { ...process.env };
  for (const key of [
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'ANDROID_AVD_HOME',
    'ANDROID_EMULATOR_HOME',
    'ANDROID_USER_HOME',
    'ANDROID_SDK_HOME',
  ])
    delete baseEnv[key];
  mkdirSync(home, { recursive: true });
  return {
    home: join(home, 'state'),
    buildCache: null,
    projectRoot: home,
    cwd: home,
    runId: name,
    env: { ...baseEnv, HOME: home, USERPROFILE: home, STIM_HOME: join(home, 'state'), ...env },
    signal: new AbortController().signal,
    output: () => {},
  };
}

function slowInventoryExecutor(): void {
  const executor = getExecutor();
  setExecutor({
    ...executor,
    runFileAsync(file, args, options) {
      expect(file).toBe('xcrun');
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
      const body = args.includes('devices')
        ? "({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [{ udid: process.env.STIM_RUN_ID, name: 'stim-test', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15' }] } })"
        : args.includes('runtimes')
          ? '({ runtimes: [] })'
          : '({})';
      return executor.runFileAsync(
        process.execPath,
        ['-e', `setTimeout(() => process.stdout.write(JSON.stringify(${body})), 200)`],
        options,
      );
    },
  });
}

test('GC native inventory keeps the event loop responsive during bounded child reads', async () => {
  slowInventoryExecutor();
  const operation = context('responsive', { STIM_RUN_ID: 'ambient' });
  const env = { ...operation.env, STIM_RUN_ID: 'responsive' };
  let finished = false;
  const pending = withAmbientContext(operation, () => collectInventory(null, [], env)).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(finished).toBe(false);
  const result = await pending;
  expect(result.devices.find((device) => device.kind === 'ios')?.id).toBe('responsive');
  expect(result.notices).toEqual([]);
});

test('concurrent GC inventories keep device ownership and Android paths in each operation context', async () => {
  slowInventoryExecutor();
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const sdkA = join(root, 'sdk-a');
  const avdsA = join(root, 'avd-a');
  const a = context('a', {
    STIM_RUN_ID: 'a',
    ANDROID_HOME: sdkA,
    ANDROID_AVD_HOME: avdsA,
  });
  const b = context('b', { STIM_RUN_ID: 'b' });
  const fixtures = [
    { operation: a, sdk: sdkA, avds: avdsA, api: 35 },
    { operation: b, sdk: join(b.cwd, 'Library', 'Android', 'sdk'), avds: join(b.cwd, '.android', 'avd'), api: 36 },
  ];
  for (const { operation, sdk, avds, api } of fixtures) {
    mkdirSync(join(sdk, 'system-images', `android-${api}`, 'google_apis', 'arm64-v8a'), { recursive: true });
    const tools = join(sdk, 'cmdline-tools', 'latest', 'bin');
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, 'sdkmanager'), '');
    const avd = join(avds, `stim-${operation.runId}.avd`);
    mkdirSync(avd, { recursive: true });
    writeFileSync(join(avds, `stim-${operation.runId}.ini`), `path=${avd}\n`);
    writeFileSync(join(avd, 'config.ini'), `image.sysdir.1=system-images/android-${api}/google_apis/arm64-v8a/\n`);
    mkdirSync(operation.home, { recursive: true });
    writeFileSync(
      join(operation.home, 'created-devices.json'),
      JSON.stringify({ version: 1, ios: [operation.runId], android: [`stim-${operation.runId}`], web: [] }),
    );
  }
  const results = await Promise.all(
    fixtures.map(({ operation }) => withAmbientContext(operation, () => collectInventory(null, [], operation.env))),
  );
  for (const [index, result] of results.entries()) {
    const fixture = fixtures[index];
    assert(fixture);
    const { operation, sdk, api } = fixture;
    expect(result.devices.map(({ id, owner }) => [id, owner])).toEqual([
      [operation.runId, 'orphaned'],
      [`stim-${operation.runId}`, 'orphaned'],
    ]);
    expect(result.systemImages).toEqual([
      expect.objectContaining({
        package: `system-images;android-${api};google_apis;arm64-v8a`,
        directory: join(sdk, 'system-images', `android-${api}`, 'google_apis', 'arm64-v8a'),
        avdCount: 1,
        command: `${JSON.stringify(join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))} --uninstall ${JSON.stringify(`system-images;android-${api};google_apis;arm64-v8a`)}`,
      }),
    ]);
    expect(result.notices).toEqual([]);
  }
  expect(process.env).toEqual(originalEnv);
  expect(process.cwd()).toBe(originalCwd);
});
