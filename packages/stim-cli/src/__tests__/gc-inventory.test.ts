import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { collectInventory } from '../commands/gc/inventory.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';

let root: string;
let restorePlatform: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-gc-inventory-'));
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  restorePlatform = () => platform.mockRestore();
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

describe.skipIf(process.platform === 'win32')('POSIX inventory cancellation', () => {
  test.each([false, true])(
    'native inventory stops after cancellation or unresolved cleanup without a report runtime (refusal=%s)',
    async (unavailable) => {
      const operation = context('cancelled');
      const controller = new AbortController();
      operation.signal = controller.signal;
      const executor = getExecutor();
      const real = executor.runFileAsync.bind(executor);
      const children: { pid: number; processToken: string }[] = [];
      const closes: Promise<void>[] = [];
      const inspect = vi
        .spyOn(identities, 'inspectProcessIdentity')
        .mockImplementation((record) =>
          unavailable && children.some((child) => child.pid === record?.pid)
            ? 'unknown'
            : inspectProcessIdentity(record),
        );
      const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((_file, _args, options) => {
        restorePlatform();
        return real(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], {
          ...options,
          timeoutMs: 250,
          onSpawn: (child) => {
            options.onSpawn?.(child);
            const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
            if (child.pid === undefined || !birth?.ok) throw new Error('The inventory fixture child has no identity');
            children.push({ pid: child.pid, processToken: birth.token });
            closes.push(new Promise<void>((resolve) => child.once('close', resolve)));
            if (!unavailable) child.stdout?.once('data', () => controller.abort());
          },
        });
      });
      try {
        await expect(
          withAmbientContext(operation, () => collectInventory(null, [], operation.env, operation)),
        ).rejects.toMatchObject(unavailable ? { code: 'STIM_CLAIM_UNAVAILABLE' } : { name: 'AbortError' });
        expect(children).toHaveLength(1);
        expect(inspectProcessIdentity(children[0])).toBe(unavailable ? 'same' : 'gone');
      } finally {
        inspect.mockRestore();
        probe.mockRestore();
        controller.abort();
        for (const child of children) if (inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
        await Promise.all(closes);
        for (const child of children) expect(await waitForProcessExit(child, 5000)).toBe(true);
      }
    },
  );
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
