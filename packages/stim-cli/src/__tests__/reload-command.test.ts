import { Command } from 'commander';
import type { ProjectRecord } from '../config.ts';
import { registerReload, runReload, type ReloadDeps } from '../commands/reload.ts';
import type { WorkspaceLaunchRecord } from '../supervisor/state.ts';

const iosLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.ios',
  deviceId: 'U1',
  metroPort: 8082,
  release: false,
  launchedAt: '2026-09-04T12:00:00.000Z',
};

const androidLaunch: WorkspaceLaunchRecord = {
  appId: 'com.example.android',
  deviceId: 'emulator-5554',
  metroPort: 8082,
  release: false,
  launchedAt: '2026-09-04T12:00:00.000Z',
};

const project: ProjectRecord = {
  metroPort: 8082,
  platforms: {
    ios: { deviceUdid: 'U1', deviceName: 'stim-ios', owned: true },
    android: { avdName: 'stim-android', serial: 'emulator-5554', owned: true },
  },
};

function reloadDeps(overrides: Partial<ReloadDeps> = {}): Partial<ReloadDeps> {
  return {
    findProjectRoot: () => '/project',
    getProject: () => project,
    readLaunches: () => ({ android: androidLaunch }),
    resolveIos: () => ({ sim: { udid: 'U1', name: 'stim-ios', state: 'Booted' } }) as never,
    resolveAndroid: () => ({ serial: 'emulator-5554' }),
    iosProcess: () => 42,
    androidProcess: () => 43,
    resolveMetro: async () => ({ metro: { pid: 1, leader: 1, cwd: '/project' } }),
    reloadMetro: async () => ({ ok: true, peers: 1, targets: 1 }),
    ...overrides,
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

test('reload auto-selects the sole live owned app and reports its strategy', async () => {
  const result = await runReload({ root: '/project', deps: reloadDeps() });

  expect(result).toEqual({
    ok: true,
    facts: {
      platform: 'android',
      deviceId: 'emulator-5554',
      deviceName: 'stim-android',
      appId: 'com.example.android',
      metroPort: 8082,
      strategy: 'metro-websocket',
      targets: 1,
    },
  });
});

test('reload addresses Metro with the target platform and app', async () => {
  const calls: unknown[] = [];
  await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      reloadMetro: async (port, options) => {
        calls.push([port, options]);
        return { ok: true, peers: 1, targets: 1 };
      },
    }),
  });
  await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadMetro: async (port, options) => {
        calls.push([port, options]);
        return { ok: true, peers: 1, targets: 1 };
      },
    }),
  });

  expect(calls).toEqual([
    [8082, { role: 'android', appId: 'com.example.android' }],
    [8082, { role: 'ios', appId: 'com.example.ios' }],
  ]);
});

test('reload requires a platform when both owned apps are live', async () => {
  const result = await runReload({
    root: '/project',
    deps: reloadDeps({ readLaunches: () => ({ ios: iosLaunch, android: androidLaunch }) }),
  });

  expect(result).toEqual({
    ok: false,
    error: {
      code: 'STIM_RELOAD_AMBIGUOUS',
      message: 'Both the iOS and Android apps are running.',
      remedy: 'Choose one with `stim reload ios` or `stim reload android`.',
    },
  });
});

test('reload ignores a stopped platform while auto-selecting the live one', async () => {
  const result = await runReload({
    root: '/project',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch, android: androidLaunch }),
      iosProcess: () => null,
    }),
  });

  expect(result.ok && result.facts.platform).toBe('android');
});

test('reload refuses release launches before issuing a reload action', async () => {
  let called = false;
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      readLaunches: () => ({ android: { ...androidLaunch, release: true, metroPort: null } }),
      reloadMetro: async () => {
        called = true;
        return { ok: true, peers: 1, targets: 1 };
      },
    }),
  });

  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_RELOAD_RELEASE' } });
  expect(called).toBe(false);
});

test('reload refuses a launch record that no longer belongs to the configured owned device', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({ getProject: () => ({ ...project, platforms: { android: { owned: false } } }) }),
  });

  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_RELOAD_UNOWNED' } });
});

test('an app Metro cannot see gets the automation remedy, not a restart', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      reloadMetro: async () => ({ failed: true, noPeer: true, peers: 0, reason: 'No Android app connected.' }),
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'STIM_RELOAD_FAILED',
      remedy: expect.stringContaining('agent-device snapshot -i --platform android --serial emulator-5554'),
    },
  });
});

test('a no-peer reload names the first-load causes that need automation', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadMetro: async () => ({ failed: true, noPeer: true, peers: 0, reason: 'No app connected.' }),
    }),
  });

  const remedy = (result.ok === false ? result.error.remedy : '') ?? '';
  expect(remedy).toContain('Stim broadcast a reload anyway');
  expect(remedy).toContain('reconnects every 2 seconds');
  expect(remedy).toContain('run `stim reload ios` once more');
  expect(remedy).toContain('first bundle');
  // Check the screen before spending a round trip on a retry.
  expect(remedy.indexOf('check the expected UI')).toBeLessThan(remedy.indexOf('once more'));
});

// reload refuses anything that is not this workspace's owned local device, so a
// phone never reaches this branch and its Local Network remedy does not belong here.
test('a no-peer reload does not offer the phone-only Local Network cause', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadMetro: async () => ({ failed: true, noPeer: true, peers: 0, reason: 'No app connected.' }),
    }),
  });

  expect((result.ok === false ? result.error.remedy : '') ?? '').not.toContain('Local Network');
});

test('a no-peer reload on Android does not claim an iOS first-bundle cause', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      reloadMetro: async () => ({ failed: true, noPeer: true, peers: 0, reason: 'No app connected.' }),
    }),
  });

  const remedy = (result.ok === false ? result.error.remedy : '') ?? '';
  expect(remedy).toContain('run `stim reload android` once more');
  expect(remedy).not.toContain('first bundle');
});

test('a no-peer reload routes to the device reload controls before a relaunch', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadMetro: async () => ({ failed: true, noPeer: true, peers: 0, reason: 'No app connected.' }),
    }),
  });

  const remedy = (result.ok === false ? result.error.remedy : '') ?? '';
  expect(remedy).toContain("press the error screen's Reload button");
  expect(remedy).toContain('open the dev menu and press Reload');
  expect(remedy.indexOf('Reload button')).toBeLessThan(remedy.indexOf('--relaunch'));
});

// A workspace Metro serves one app, so several matching peers are that app on
// several devices. The agent asked about one device and has to learn the others
// reloaded too.
test('a reload that reached several devices says so and counts them', async () => {
  const deps = reloadDeps({ reloadMetro: async () => ({ ok: true, peers: 3, targets: 2 }) });
  const result = await runReload({ root: '/project', platform: 'android', deps });

  expect(result.ok && result.facts).toMatchObject({ strategy: 'metro-websocket', targets: 2 });

  const program = new Command();
  registerReload(program, deps);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android']);
  } finally {
    console.log = originalLog;
  }

  expect(lines[0]).toContain('2 devices are running this app');
  expect(lines[0]).toContain('not only emulator-5554');
});

test('a reload that reached one device does not mention other devices', async () => {
  const program = new Command();
  registerReload(program, reloadDeps());
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android']);
  } finally {
    console.log = originalLog;
  }

  expect(lines[0]).not.toContain('devices are running this app');
});

// The bare React Native dev server cannot enumerate peers, so the reload is a
// broadcast and Stim cannot prove the named app was among the apps it reached.
// The output has to say so, or exit 0 reads as proof this app reloaded.
test('a broadcast reload reports its wider scope in the facts and the plain output', async () => {
  const deps = reloadDeps({ reloadMetro: async () => ({ ok: true, broadcast: true }) });
  const result = await runReload({ root: '/project', platform: 'android', deps });

  expect(result.ok && result.facts.strategy).toBe('metro-broadcast');

  const program = new Command();
  registerReload(program, deps);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android']);
  } finally {
    console.log = originalLog;
  }

  expect(lines[0]).toContain('cannot name its connected apps');
  expect(lines[0]).toContain('cannot confirm com.example.android was one');
});

test('a targeted reload does not claim the broadcast scope', async () => {
  const program = new Command();
  registerReload(program, reloadDeps());
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android']);
  } finally {
    console.log = originalLog;
  }

  expect(lines[0]).not.toContain('cannot name its connected apps');
  expect(lines[0]).not.toContain('cannot confirm');
});

// Metro answering nothing says nothing about the app, so the agent is sent back
// to the dev server rather than to the device's reload controls.
test.each([
  ['a probe timeout', 'Metro did not answer on port 8082.'],
  ['a socket error', 'Metro reload failed: connect ECONNREFUSED'],
])('an unreachable Metro asks for a retry, not device automation: %s', async (_label, reason) => {
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadMetro: async () => ({ failed: true, unreachable: true, reason }),
    }),
  });

  expect(result).toMatchObject({ ok: false, error: { code: 'STIM_RELOAD_FAILED', message: reason } });
  const remedy = (result.ok === false ? result.error.remedy : '') ?? '';
  expect(remedy).toContain('Run `stim reload ios` again.');
  expect(remedy).toContain('stim doctor');
  expect(remedy).not.toContain('agent-device');
  expect(remedy).not.toContain('--relaunch');
});

test('a no-peer reload prints the exact agent-device commands for the iOS target', async () => {
  const result = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      reloadMetro: async () => ({ failed: true, noPeer: true, peers: 0, reason: 'No app connected.' }),
    }),
  });

  expect(result).toMatchObject({
    ok: false,
    error: { code: 'STIM_RELOAD_FAILED', message: 'No app connected.' },
  });
  const remedy = (result.ok === false ? result.error.remedy : '') ?? '';
  expect(remedy).toContain('agent-device snapshot -i --platform ios --udid U1');
  expect(remedy).toContain('agent-device open com.example.ios --platform ios --udid U1 --metro-port 8082 --relaunch');
});

test('reload turns owned-device inspection failures into actionable errors', async () => {
  const ios = await runReload({
    root: '/project',
    platform: 'ios',
    deps: reloadDeps({
      readLaunches: () => ({ ios: iosLaunch }),
      resolveIos: () => {
        throw new Error('simctl unavailable');
      },
    }),
  });
  const android = await runReload({
    root: '/project',
    platform: 'android',
    deps: reloadDeps({
      resolveAndroid: () => {
        throw new Error('adb unavailable');
      },
    }),
  });

  expect(ios).toMatchObject({ ok: false, error: { code: 'STIM_RELOAD_PROBE_FAILED', remedy: expect.any(String) } });
  expect(android).toMatchObject({
    ok: false,
    error: { code: 'STIM_RELOAD_PROBE_FAILED', remedy: expect.any(String) },
  });
});

test('reload --json prints exactly one parseable facts line', async () => {
  const program = new Command();
  registerReload(program, reloadDeps());
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android', '--json']);
  } finally {
    console.log = originalLog;
  }

  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({
    platform: 'android',
    deviceId: 'emulator-5554',
    deviceName: 'stim-android',
    appId: 'com.example.android',
    metroPort: 8082,
    strategy: 'metro-websocket',
    targets: 1,
  });
});

test('reload plain output reports a request and retains the target facts', async () => {
  const program = new Command();
  registerReload(program, reloadDeps());
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await program.parseAsync(['node', 'stim', 'reload', 'android']);
  } finally {
    console.log = originalLog;
  }

  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^Reload requested for com\.example\.android /);
  expect(lines[0]).toContain('emulator-5554');
  expect(lines[0]).toContain('8082');
  expect(lines[0]).toContain('stim logs --errors');
});

test('multiple live slots of the same platform use one platform reload', async () => {
  const calls: unknown[] = [];
  const result = await runReload({
    root: '/project',
    deps: reloadDeps({
      getProject: () => ({ ...project, deviceSlots: { phone: { ios: { deviceUdid: 'U2', owned: true } } } }),
      readLaunches: () => ({ ios: iosLaunch, 'ios:phone': { ...iosLaunch, deviceId: 'U2' } }),
      resolveIos: (udid) => ({ sim: { udid, name: `stim-${udid}`, state: 'Booted' } }) as never,
      reloadMetro: async (port, options) => {
        calls.push([port, options]);
        return { ok: true, peers: 2, targets: 2 };
      },
    }),
  });
  expect(result.ok).toBe(true);
  expect(calls).toEqual([[8082, { role: 'ios', appId: iosLaunch.appId }]]);
});

test.each([true, false])(
  'a default release or old-port launch does not block a Debug sibling (release: %s)',
  async (release) => {
    const result = await runReload({
      root: '/project',
      platform: 'ios',
      deps: reloadDeps({
        getProject: () => ({ ...project, deviceSlots: { phone: { ios: { deviceUdid: 'U2', owned: true } } } }),
        readLaunches: () => ({
          ios: { ...iosLaunch, release, metroPort: release ? null : 8083 },
          'ios:phone': { ...iosLaunch, deviceId: 'U2' },
        }),
        resolveIos: (udid) => ({ sim: { udid, name: `stim-${udid}`, state: 'Booted' } }) as never,
      }),
    });
    expect(result).toMatchObject({ ok: true, facts: { deviceId: 'U2', metroPort: 8082 } });
  },
);

test('a stopped named slot keeps its slot in the reload recovery command', async () => {
  const result = await runReload({
    root: '/project',
    deps: reloadDeps({
      getProject: () => ({ ...project, deviceSlots: { phone: { ios: { deviceUdid: 'U1', owned: true } } } }),
      readLaunches: () => ({ 'ios:phone': iosLaunch }),
      iosProcess: () => null,
    }),
  });
  expect(result).toMatchObject({ ok: false, error: { remedy: 'Run `stim ios --slot phone` to launch it.' } });
});
