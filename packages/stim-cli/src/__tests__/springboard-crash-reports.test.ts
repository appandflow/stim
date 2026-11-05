import { afterEach, beforeEach, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copySpringBoardCrashReports, selectSpringBoardReports } from '../devices/springboard-crash-reports.ts';

const UDID = '68019807-1111-4222-8333-444455556666';
const NOW = Date.parse('2026-10-22T23:58:30-04:00');

function ips(coalition: string, captureTime: string): string {
  const header = JSON.stringify({ app_name: 'SpringBoard', bug_type: '309', os_version: 'iOS 27.0 (24A434)' });
  const body = JSON.stringify(
    { captureTime, procName: 'SpringBoard', parentProc: 'launchd_sim', coalitionName: coalition, pid: 99 },
    null,
    2,
  );
  return `${header}\n${body}\n`;
}

const own = (time = '2026-10-22 23:58:17.2400 -0400') => ips(`com.apple.CoreSimulator.SimDevice.${UDID}`, time);

test('selectSpringBoardReports keeps only SpringBoard reports of this simulator captured since the cutoff', () => {
  const selected = selectSpringBoardReports(
    [
      { name: 'SpringBoard-2026-10-22-235817.ips', text: own() },
      { name: 'SpringBoard-2026-10-22-235818.ips', text: own().toUpperCase().replace('SPRINGBOARD', 'SpringBoard') },
      {
        name: 'SpringBoard-2026-10-22-235819.ips',
        text: ips('com.apple.CoreSimulator.SimDevice.OTHER-UDID', '2026-10-22 23:58:19.0000 -0400'),
      },
      { name: 'SpringBoard-2026-10-22-235000.ips', text: own('2026-10-22 23:50:00.0000 -0400') },
      { name: 'backboardd-2026-10-22-235817.ips', text: own() },
      { name: 'SpringBoard-2026-10-22-235820.ips', text: 'not json\nnot json' },
      {
        name: 'SpringBoard-2026-10-22-235821.ips',
        text: ips(`com.apple.CoreSimulator.SimDevice.X${UDID}`, '2026-10-22 23:58:21.0000 -0400'),
      },
    ],
    UDID,
    NOW - 10 * 60 * 1000 + 5 * 60 * 1000,
  );
  expect(selected).toEqual(['SpringBoard-2026-10-22-235817.ips']);
});

let home: string;
let dest: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-sb-reports-'));
  dest = join(home, 'logs');
  mkdirSync(join(home, 'Library/Logs/DiagnosticReports/Retired'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function report(directory: string, name: string, text: string, ageMs = 60_000) {
  const path = join(home, 'Library/Logs/DiagnosticReports', directory, name);
  writeFileSync(path, text);
  utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs));
  return path;
}

test('copySpringBoardCrashReports stops at 40 stored reports and skips oversized ones', async () => {
  mkdirSync(dest);
  for (let i = 0; i < 39; i++) writeFileSync(join(dest, `SpringBoard-old-${i}.ips`), 'x');
  report('', 'SpringBoard-2026-10-22-235801.ips', own('2026-10-22 23:58:01.0000 -0400'), 3000);
  report('', 'SpringBoard-2026-10-22-235802.ips', own('2026-10-22 23:58:02.0000 -0400'), 2000);
  report('', 'SpringBoard-2026-10-22-235803.ips', `${own()}${' '.repeat(1024 * 1024)}`, 1000);
  const { files, dropped } = await copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home });
  expect(files).toEqual(['SpringBoard-2026-10-22-235802.ips']);
  expect(dropped).toBe(1);
  expect(readdirSync(dest).filter((name) => name.startsWith('SpringBoard-2026'))).toEqual(files);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'copySpringBoardCrashReports names a failed write instead of counting it as over the limits',
  async () => {
    report('', 'SpringBoard-2026-10-22-235817.ips', own());
    mkdirSync(dest);
    chmodSync(dest, 0o500);
    try {
      const result = await copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home });
      expect(result).toMatchObject({ files: [], dropped: 0, failure: expect.stringContaining('EACCES') });
    } finally {
      chmodSync(dest, 0o700);
    }
    expect(readdirSync(dest)).toEqual([]);
  },
);
