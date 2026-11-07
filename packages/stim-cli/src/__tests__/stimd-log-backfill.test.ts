import { logcatBackfillArgs } from '../stimd/logs/android.ts';
import { logShowArgs } from '../stimd/logs/ios.ts';

test('iOS backfill uses the same executable predicate as the live stream', () => {
  expect(logShowArgs('U1', 'FixtureDev', 'Fixture', 1_700_000_000_123)).toEqual([
    'simctl',
    'spawn',
    'U1',
    'log',
    'show',
    '--style',
    'ndjson',
    '--start',
    '@1700000000',
    '--predicate',
    'processImagePath ENDSWITH "/FixtureDev.app/Fixture"',
    '--info',
    '--no-pager',
  ]);
});

test('Android backfill converts the host launch time to device time and exits after the dump', () => {
  expect(logcatBackfillArgs('serial', 3132, 1_700_000_000_123, 250)).toEqual([
    '-s',
    'serial',
    'logcat',
    '-d',
    '-T',
    '1699999999.873',
    '--pid',
    '3132',
    '-v',
    'time,epoch',
  ]);
});

test.skipIf(process.platform === 'win32')(
  'Android history uses a translated clock and refuses an unknown clock',
  async () => {
    const { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } =
      await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { delimiter, join } = await import('node:path');
    const { backfillDeviceLog } = await import('../stimd/logs/backfill.ts');
    const { createLogWriters } = await import('../stimd/logs/writer.ts');
    const { workspaceLogsDir } = await import('../workspace/paths.ts');
    const { parseNdjsonText } = await import('../ndjson.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-history-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-history-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const adb = join(bin, 'adb');
    writeFileSync(
      adb,
      `#!/bin/sh\ncase "$*" in\n  *pidof*) echo 3132;;\n  *date*) if [ "$BAD_CLOCK" = 1 ]; then echo bad; else date +%s000; fi;;\n  *logcat*) date '+%s.000 3132 3132 I Test: historical launch';;\nesac\n`,
    );
    chmodSync(adb, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const writers = createLogWriters(() => {});
    try {
      const sink = await writers.open(
        { streamId: 'android', slotKey: 'android', root, platform: 'android', physical: false, attribution: {} },
        () => {},
      );
      const input = {
        root,
        streamId: 'android',
        spec: { root, platform: 'android' as const, serial: 'emulator-1', packageName: 'com.test.app' },
        since: Date.now() - 3000,
        env,
        signal: new AbortController().signal,
        warm: () => false,
        sink,
      };
      await backfillDeviceLog(input);
      await expect(backfillDeviceLog({ ...input, env: { ...env, BAD_CLOCK: '1' } })).rejects.toThrow(
        'device clock could not be read',
      );
      sink.writer.close();
      await sink.closed();
      const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
      expect(records.filter((record) => record.msg === 'historical launch')).toHaveLength(1);
    } finally {
      await writers.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
