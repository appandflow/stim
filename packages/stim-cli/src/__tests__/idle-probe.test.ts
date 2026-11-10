import assert from 'node:assert';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertProject } from '../workspace/config.ts';
import { workspaceIdleProbe } from '../stimd/metro/idle-stop.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { startBuildProgress } from '../engine/build-progress.ts';
import { deviceLeasePath, takeLease } from '../engine/device-lease.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('the workspace idle probe', () => {
  const MINUTE = 60_000;

  function useProbeHost({ ps, adb = '' }: { ps: string | null; adb?: string | null }) {
    const outputs = { output: adb };
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileQuiet: (file, args, opts) =>
        file === 'ps' ? ps : file === 'adb' ? outputs.output : real.runFileQuiet(file, args, opts),
    });
    const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = tmpHome;
    onTestFinished(() => {
      resetExecutor();
      for (const [key, value] of Object.entries(home)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    return outputs;
  }

  test('the workspace probe blocks during a build and while a workspace device is driven', async () => {
    useProbeHost({ ps: '' });
    const probe = workspaceIdleProbe(root);
    expect(await probe.blocker()).toBe(null);

    const attempt = tryAcquireClaim({
      root: join(tmpHome, 'native-run.lock'),
      mode: 'exclusive',
      label: 'native-run lock',
    });
    assert(attempt.acquired);
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim: attempt.acquired });
    expect(await probe.blocker()).toBe('a build is in progress');
    releaseClaim(attempt.acquired);
    expect(await probe.blocker()).toBe(null);

    upsertProject(root, { platforms: { ios: { deviceUdid: 'STIM-IDLE-TEST-UDID', owned: true } } });
    expect(await probe.blocker()).toBe(null);
    takeLease({ root, platform: 'ios', id: 'STIM-IDLE-TEST-UDID', kind: 'declared' });
    expect(await probe.blocker()).toMatch(/^ios device STIM-IDLE-TEST-UDID is leased by stim device lock until /);
  });

  test('a physical device this workspace locks blocks the stop until the lease expires', async () => {
    useProbeHost({ ps: '' });
    const probe = workspaceIdleProbe(root);
    takeLease({ root, platform: 'android', id: 'PHYSICAL-SERIAL', kind: 'declared', durationMs: 30 * MINUTE });
    expect(await probe.blocker()).toMatch(/^android device PHYSICAL-SERIAL is leased by stim device lock until /);

    vi.setSystemTime(Date.now() + 30 * MINUTE);
    expect(await probe.blocker()).toBe(null);

    writeFileSync(deviceLeasePath('android', 'PHYSICAL-SERIAL'), '{');
    expect(await probe.blocker()).toBe('android device PHYSICAL-SERIAL has a lease that cannot be read');
    rmSync(deviceLeasePath('android', 'PHYSICAL-SERIAL'));
    expect(await probe.blocker()).toBe(null);
  });

  test('on Windows, where ps does not exist, only the missing host driver probe is ignored', async () => {
    upsertProject(root, { platforms: { android: { serial: 'emulator-5554', owned: true } } });
    const adb = useProbeHost({ ps: null, adb: '  PID ARGS\n  1 init\n' });
    expect(await workspaceIdleProbe(root, { platform: 'darwin' }).blocker()).toBe(
      'android device emulator-5554 has unknown activity (driver-process)',
    );
    expect(await workspaceIdleProbe(root, { platform: 'win32' }).blocker()).toBe(null);

    adb.output = null;
    expect(await workspaceIdleProbe(root, { platform: 'win32' }).blocker()).toBe(
      'android device emulator-5554 has unknown activity (instrumentation)',
    );
  });
});
