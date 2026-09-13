import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getExecutor, resetExecutor } from '../exec.ts';
import { listIosDevices, iosDeviceProcess } from '../engine/ios-device.ts';

describe('listIosDevices against a real devicectl', { timeout: 120_000 }, () => {
  beforeAll(() => {
    if (process.platform !== 'darwin') throw new Error('Compatibility requires macOS with Xcode and devicectl.');
    getExecutor().runFile('xcrun', ['devicectl', '--version'], { timeoutMs: 15_000 });
  });

  test('the argv is accepted and every entry it returns is well formed', ({ onTestFinished }) => {
    resetExecutor();
    const unrelated = mkdtempSync(join(tmpdir(), 'stim-devicectl-'));
    onTestFinished(() => rmSync(unrelated, { recursive: true, force: true }));
    const executor = getExecutor();
    let outPath = '';
    let discoveryError: unknown;
    const devices = listIosDevices({
      exec: {
        ...executor,
        runFile(file, args, options) {
          outPath = args?.[args.indexOf('-j') + 1] ?? '';
          try {
            return executor.runFile(file, args, options);
          } catch (error) {
            discoveryError = error;
            throw error;
          }
        },
      },
    });
    if (discoveryError) throw discoveryError;
    expect(Array.isArray(devices)).toBe(true);
    for (const found of devices) {
      expect(found.udid.length).toBeGreaterThan(0);
      expect(found.name.length).toBeGreaterThan(0);
    }
    expect(outPath).not.toBe('');
    expect(existsSync(dirname(outPath))).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  }, 60_000);

  test('the process-probe argv is accepted by the real devicectl when a phone is connected', () => {
    resetExecutor();
    const [connected] = listIosDevices();
    if (!connected)
      throw new Error(
        'Compatibility requires a connected, paired, unlocked iPhone with Developer Mode enabled; process argv was not verified.',
      );
    const executor = getExecutor();
    let failure = '';
    let timedOut = false;
    let probedUdid: string | undefined;
    const pid = iosDeviceProcess(
      { udid: connected.udid, appName: 'NoSuchAppStimWouldEverBuild' },
      {
        exec: {
          ...executor,
          runFile(file, args, options) {
            probedUdid = args?.[args.indexOf('--device') + 1];
            try {
              return executor.runFile(file, args, options);
            } catch (error) {
              const failed = error as Error & { stderr?: unknown; stdout?: unknown; code?: unknown };
              failure = [failed.message, failed.stderr, failed.stdout].filter(Boolean).join('\n');
              timedOut = failed.code === 'ETIMEDOUT';
              throw error;
            }
          },
        },
      },
    );
    expect(probedUdid).toBe(connected.udid);
    if (pid === undefined) {
      if (timedOut) throw new Error(`devicectl process probe timed out\n${failure}`);
      throw new Error(failure || 'The probe failed without a devicectl error');
    }
    expect(pid).toBe(null);
  }, 120_000);
});
