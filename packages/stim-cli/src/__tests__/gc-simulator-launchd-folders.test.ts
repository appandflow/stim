import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resetExecutor, setExecutor } from '../exec.ts';
import { listIosLaunchdOverridesFolders, type IosSimRecord } from '../devices/ios.ts';
import { findSimulatorLaunchdLeftovers, sizeSimulatorLaunchdFolders } from '../commands/gc/devices.ts';
import { formatGcReport, gcReportSections } from '../commands/gc/report.ts';

const GONE = 'A48B2B1E-3768-48D8-9816-86B2AC7F2188';
const LISTED = '9981F3FA-0F95-4720-B4D4-FBC8E90C10A8';

afterEach(() => resetExecutor());

function sim(udid: string): IosSimRecord {
  return {
    udid,
    name: 'stim-app',
    state: 'Shutdown',
    runtime: 'iOS-27-0',
    deviceTypeIdentifier: 'iphone-17',
    available: true,
  };
}

test('listIosLaunchdOverridesFolders lists only SimDevice directories named by a UDID', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-launchd-'));
  try {
    mkdirSync(join(root, `com.apple.CoreSimulator.SimDevice.${GONE}`));
    mkdirSync(join(root, 'com.apple.CoreSimulator.SimDevice.not-a-udid'));
    mkdirSync(join(root, 'com.apple.launchd.other'));
    writeFileSync(join(root, `com.apple.CoreSimulator.SimDevice.${LISTED}`), '');
    expect(listIosLaunchdOverridesFolders(root)).toEqual([
      { udid: GONE, path: join(root, `com.apple.CoreSimulator.SimDevice.${GONE}`) },
    ]);
    expect(listIosLaunchdOverridesFolders(join(root, 'missing'))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a launchd folder is a leftover only when no listed simulator, unavailable ones included, has its UDID', () => {
  const folders = [
    { udid: GONE, path: `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${GONE}` },
    { udid: LISTED, path: `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${LISTED}` },
  ];
  expect(findSimulatorLaunchdLeftovers({ folders, sims: [{ ...sim(LISTED), available: false }] })).toEqual([
    folders[0],
  ]);
});

test('sizes come from one du call, and a folder du did not report has no size', async () => {
  const gone = { udid: GONE, path: `/tmp/com.apple.CoreSimulator.SimDevice.${GONE}` };
  const listed = { udid: LISTED, path: `/tmp/com.apple.CoreSimulator.SimDevice.${LISTED}` };
  const folders = [gone, listed];
  const calls: string[][] = [];
  setExecutor({
    runFile: (file: string, args: string[] = []) => {
      calls.push([file, ...args]);
      return `2072\t${gone.path}\n`;
    },
  });
  expect(await sizeSimulatorLaunchdFolders(folders)).toEqual([
    { ...gone, bytes: 2072 * 1024 },
    { ...listed, bytes: null },
  ]);
  expect(calls).toEqual([['du', '-sk', gone.path, listed.path]]);

  setExecutor({
    runFile: () => {
      throw new Error('du timed out');
    },
  });
  expect(await sizeSimulatorLaunchdFolders(folders)).toEqual([
    { ...folders[0], bytes: null },
    { ...folders[1], bytes: null },
  ]);
});

test('the gc report lists leftover launchd folders as not deleted, with sizes and a manual command', () => {
  const gone = {
    udid: GONE,
    path: `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${GONE}`,
    bytes: 2 * 1024 * 1024,
  };
  const listed = { udid: LISTED, path: `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${LISTED}`, bytes: null };
  const simulatorLaunchdFolders = [gone, listed];
  const text = formatGcReport({ simulatorLaunchdFolders }).join('\n');
  expect(text).toMatch(/Simulator launchd folders with no simulator \(2\) - NOT deleted/);
  expect(formatGcReport({ simulatorLaunchdFolders: [gone, { ...listed, bytes: 1024 * 1024 }] }).join('\n')).toMatch(
    /Simulator launchd folders with no simulator \(2, 3M\)/,
  );
  expect(text).toMatch(/NOT deleted/);
  expect(text).toContain(`  ${GONE} - `);
  expect(text).toContain(`  ${LISTED}\n`);
  expect(gcReportSections({ simulatorLaunchdFolders }).simulatorLaunchdFolders).toEqual([
    { ...gone, command: `rm -rf "${gone.path}"` },
    { ...listed, command: `rm -rf "${listed.path}"` },
  ]);
  expect(formatGcReport({}).join('\n')).not.toMatch(/launchd folders/);
});

test('when du exits non-zero because a folder vanished, the sizes it did print are kept', async () => {
  const gone = { udid: GONE, path: `/tmp/com.apple.CoreSimulator.SimDevice.${GONE}` };
  const vanished = { udid: LISTED, path: `/tmp/com.apple.CoreSimulator.SimDevice.${LISTED}` };
  setExecutor({
    runFile: () => {
      throw Object.assign(new Error('Command failed: du'), { stdout: `2072\t${gone.path}\n` });
    },
  });
  expect(await sizeSimulatorLaunchdFolders([gone, vanished])).toEqual([
    { ...gone, bytes: 2072 * 1024 },
    { ...vanished, bytes: null },
  ]);
});
