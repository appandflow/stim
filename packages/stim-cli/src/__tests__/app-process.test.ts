import type { DeviceProcessTables, HostProcess } from '../devices/activity.ts';
import { createAppProcessReader } from '../devices/app-process.ts';

const UDID = '7466D06C-1AE4-4EDB-8A93-6B8A43A7A47A';
const OTHER = '23A8451A-78C9-4556-9B3C-C87E9635F72D';
const bundle = (udid: string, app: string) =>
  `/Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/A57BFC16/${app}`;

function tables(host: string[] | null, adb: string | null = null): DeviceProcessTables {
  return {
    host: () => host?.map((command, i): HostProcess => ({ pid: i + 1, startedAt: null, command })) ?? null,
    android: () => adb,
  };
}

const ids: Record<string, string | null> = {
  [bundle(UDID, 'My App.app')]: 'com.example.app',
  [bundle(OTHER, 'My App.app')]: 'com.example.app',
  [bundle(UDID, 'Widget.app')]: null,
};

describe('app process state', () => {
  const ios = { platform: 'ios' as const, id: UDID, appId: 'com.example.app' };

  test('a simulator app is running only when its main executable runs on that simulator', () => {
    const readId = (path: string) => ids[path] ?? null;
    const running = createAppProcessReader(
      tables([`${bundle(UDID, 'My App.app')}/My App --initialUrl http://x/`]),
      readId,
    );
    expect(running(ios)).toEqual({ id: 'com.example.app', state: 'running' });

    const elsewhere = createAppProcessReader(
      tables([
        `${bundle(OTHER, 'My App.app')}/My App`,
        `${bundle(UDID, 'My App.app')}/PlugIns/Share.appex/Share`,
        `/usr/bin/lldb ${bundle(UDID, 'My App.app')}/My App`,
        `/usr/bin/tool --path=${bundle(UDID, 'My App.app')}/My App`,
      ]),
      readId,
    );
    expect(elsewhere(ios).state).toBe('stopped');
  });

  test('an unreadable process table or app bundle is unknown, never stopped', () => {
    expect(createAppProcessReader(tables(null), () => 'com.example.app')(ios).state).toBe('unknown');
    const unreadable = createAppProcessReader(tables([`${bundle(UDID, 'Widget.app')}/Widget`]), () => null);
    expect(unreadable(ios).state).toBe('unknown');
  });

  test('an emulator app is running only when a process is named exactly its package', () => {
    const android = { platform: 'android' as const, id: 'emulator-5554', appId: 'com.example.app' };
    const read = (adb: string | null) => createAppProcessReader(tables([], adb))(android).state;
    expect(read('  PID ARGS\n 4120 com.example.app\n')).toBe('running');
    expect(read('  PID ARGS\n 4121 com.example.app:remote\n 4122 com.example.app.debug\n')).toBe('stopped');
    expect(read(null)).toBe('unknown');
  });
});
