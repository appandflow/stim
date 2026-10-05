import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostRoot, readHostedSessions } from '../state/device-host.ts';
import { parseHostedAppManifest } from '../state/hosted-app.ts';

const file = (path: string, kind = 'file') => ({ path, kind, size: 1, sha256: 'a'.repeat(64) });

test('rejects traversal, aliases and entries below a file or link before any bundle materialization', () => {
  for (const paths of [
    ['Info.plist', '../escape'],
    ['Info.plist', '/absolute'],
    ['Info.plist', 'resources/./value'],
    ['Info.plist', 'INFO.plist'],
    ['Info.plist', 'Resources', 'resources/value'],
  ])
    expect(parseHostedAppManifest(paths.map((path) => file(path)))).toBeNull();
  expect(
    parseHostedAppManifest([file('Info.plist'), file('Frameworks/Current', 'link'), file('Frameworks/Current/binary')]),
  ).toBeNull();
  expect(parseHostedAppManifest([file('Resources/value'), file('Info.plist')])?.map((each) => each.path)).toEqual([
    'Info.plist',
    'Resources/value',
  ]);
});

test('macOS manifests require a Contents plist and executable while preserving iOS and APK delivery', () => {
  const plist = file('Contents/Info.plist');
  const executable = file('Contents/MacOS/Fixture', 'exec');
  expect(parseHostedAppManifest([plist, executable])).toHaveLength(2);
  expect(parseHostedAppManifest([plist])).toBeNull();
  expect(parseHostedAppManifest([executable])).toBeNull();
  expect(parseHostedAppManifest([plist, file('Contents/MacOS/Fixture')])).toBeNull();
  expect(parseHostedAppManifest([file('Contents/Info.plist', 'link'), executable])).toBeNull();
  expect(parseHostedAppManifest([file('Info.plist')])).toHaveLength(1);
  expect(parseHostedAppManifest([file('App.apk')])).toHaveLength(1);
});

test('journal rejects missing, foreign and mismatched macOS app slots', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-hosted-journal-'));
  process.env.STIM_HOME = home;
  try {
    mkdirSync(deviceHostRoot(), { recursive: true });
    const record = {
      platform: 'macos',
      workspace: '/client/worktree',
      slot: 'default',
      attempt: 'first',
      id: '12345678-1234-1234-1234-123456789abc',
      client: 'client',
      state: 'ready',
      appSlot: 3,
      device: { architecture: 'arm64', macosVersion: '27.0', appSlot: 3 },
      createdAt: new Date().toISOString(),
    };
    const write = (value: object) =>
      writeFileSync(join(deviceHostRoot(), 'sessions.json'), JSON.stringify({ version: 1, sessions: [value] }));
    write(record);
    expect(readHostedSessions()).toEqual([record]);
    for (const invalid of [
      { appSlot: undefined },
      { appSlot: 0 },
      { appSlot: 2 },
      { device: { ...record.device, appSlot: 4 } },
      { platform: 'ios', device: null, state: 'preparing' },
      { platform: 'android', appSlot: 3, device: null, state: 'preparing', consolePort: 5554 },
    ]) {
      write({ ...record, ...invalid });
      expect(() => readHostedSessions()).toThrow('Malformed hosted session record');
    }
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
