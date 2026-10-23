import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

test('copySpringBoardCrashReports copies matches from DiagnosticReports and Retired and leaves the sources in place', async () => {
  const live = report('', 'SpringBoard-2026-10-22-235817.ips', own());
  const retired = report('Retired', 'SpringBoard-2026-10-22-235800.ips', own('2026-10-22 23:58:00.0000 -0400'), 90_000);
  report(
    '',
    'SpringBoard-2026-10-22-235810.ips',
    ips('com.apple.CoreSimulator.SimDevice.OTHER', '2026-10-22 23:58:10.0000 -0400'),
  );
  report('', 'SpringBoard-2026-10-22-100000.ips', own('2026-10-22 10:00:00.0000 -0400'), 13 * 3600_000);

  const { files } = await copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home });

  expect(files.toSorted()).toEqual(['SpringBoard-2026-10-22-235800.ips', 'SpringBoard-2026-10-22-235817.ips']);
  expect(readdirSync(dest).toSorted()).toEqual(files.toSorted());
  expect(readFileSync(join(dest, 'SpringBoard-2026-10-22-235817.ips'), 'utf8')).toBe(own());
  expect(readFileSync(live, 'utf8')).toBe(own());
  expect(readFileSync(retired, 'utf8')).toContain('23:58:00');
  expect((await copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home })).files).toEqual(files);
});

test('copySpringBoardCrashReports finds nothing when no report matches and creates no copy', async () => {
  report(
    '',
    'SpringBoard-2026-10-22-235810.ips',
    ips('com.apple.CoreSimulator.SimDevice.OTHER', '2026-10-22 23:58:10.0000 -0400'),
  );
  expect(await copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home })).toEqual({
    files: [],
    dropped: 0,
  });
  expect(readdirSync(home)).not.toContain('logs');
});

test('copySpringBoardCrashReports tolerates missing report folders', async () => {
  rmSync(join(home, 'Library'), { recursive: true });
  expect(await copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home })).toEqual({
    files: [],
    dropped: 0,
  });
});

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

test('copySpringBoardCrashReports reports an unreadable report folder instead of finding nothing', async () => {
  rmSync(join(home, 'Library/Logs/DiagnosticReports/Retired'), { recursive: true });
  writeFileSync(join(home, 'Library/Logs/DiagnosticReports/Retired'), 'not a directory');
  await expect(copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home })).rejects.toThrow(/ENOTDIR/);
});

test('copySpringBoardCrashReports surfaces a failed write instead of counting it as over the limits', async () => {
  report('', 'SpringBoard-2026-10-22-235817.ips', own());
  mkdirSync(dest);
  chmodSync(dest, 0o500);
  try {
    await expect(copySpringBoardCrashReports({ udid: UDID, destDir: dest, now: NOW, home })).rejects.toThrow(/EACCES/);
  } finally {
    chmodSync(dest, 0o700);
  }
  expect(readdirSync(dest)).toEqual([]);
});
