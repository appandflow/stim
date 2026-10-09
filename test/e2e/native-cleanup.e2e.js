import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  cleanupTmp,
  createCleanupTracker,
  createHarness,
  dumpDiagnostics,
  verifyCleanup,
  workspaceLogsDir,
} from './native/harness.mjs';

function fixture(t, platform = 'ios', processExitTimeoutMs = 0) {
  const home = mkdtempSync(join(tmpdir(), 'stim-native-cleanup-'));
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
  });
  const cwd = join(home, 'worktree');
  const stateFile = join(workspaceLogsDir(cwd), '..', 'state.json');
  const output = {
    devices: [],
    avds: [],
    processes: '',
    status: '',
    porcelain: '',
    worktrees: '',
    gc: '',
    failure: null,
    processReads: 0,
    harnessVisible: true,
    crlf: false,
  };
  const h = {
    env: { STIM_HOME: home },
    banner() {},
    log() {},
    sh(file, argv, options) {
      if (file === output.failure) {
        assert.equal(options.allowFail, true);
        return { code: 1, stdout: '', stderr: 'fixture inspection failed' };
      }
      let stdout;
      if (file === 'xcrun') stdout = JSON.stringify({ devices: { runtime: output.devices } });
      else if (file === 'emulator') stdout = output.avds.join('\n');
      else if (file === 'ps') {
        output.processReads++;
        stdout = output.processes;
        if (output.harnessVisible) stdout += `\n${process.pid} Sat Sep 5 00:00:00 2026 node native-cleanup`;
        if (output.crlf) stdout = stdout.replaceAll('\n', '\r\n') + '\r\n';
      } else if (file === 'git' && argv.includes('status')) stdout = output.porcelain;
      else if (file === 'git' && argv.includes('worktree')) stdout = output.worktrees;
      else assert.fail(`unexpected command: ${file} ${argv.join(' ')}`);
      return { code: 0, stdout, stderr: '' };
    },
    cli(argv) {
      return { code: 0, stdout: argv[0] === 'status' ? output.status : output.gc, stderr: '' };
    },
  };
  const cleanup = createCleanupTracker({ h, platform, processExitTimeoutMs });
  return {
    cwd,
    stateFile,
    configFile: join(home, 'config.json'),
    output,
    cleanup,
    writeState(state) {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state));
    },
    verify() {
      return verifyCleanup({ h, cleanup, appDir: join(home, 'app'), created: [cwd] });
    },
  };
}

for (const platform of ['ios', 'android']) {
  test(`native cleanup ignores unrelated ${platform} devices and supervisors`, async (t) => {
    const f = fixture(t, platform);
    f.cleanup.recordBuild({ udid: 'RUN-UDID', avdName: 'stim-this-run' });
    f.output.devices = [{ udid: 'OTHER-UDID', name: 'stim-this-run', state: 'Booted' }];
    f.output.avds = ['stim-this-run-unrelated', 'personal-avd'];
    f.output.processes = ' 123 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /another/worktree';
    await f.verify();
  });

  test(`native cleanup still detects this run's leaked ${platform} device after state removal`, async (t) => {
    const f = fixture(t, platform);
    f.cleanup.recordBuild({ udid: 'RUN-UDID', avdName: 'stim-this-run' });
    f.writeState({});
    rmSync(f.stateFile);
    f.output.devices = [{ udid: 'RUN-UDID', name: 'stim-parked', state: 'Shutdown' }];
    f.output.avds = ['stim-this-run'];
    await assert.rejects(() => f.verify(), /a device from this run was left behind/);
  });

  test(`native cleanup requires ${platform} build identity`, async (t) => {
    const f = fixture(t, platform);
    assert.throws(() => f.cleanup.recordBuild({}), /build did not identify its device/);
  });

  test(`native cleanup retains a failed build's registered ${platform} device`, async (t) => {
    const f = fixture(t, platform);
    writeFileSync(
      f.configFile,
      JSON.stringify({
        projects: {
          [f.cwd]: { platforms: { [platform]: { owned: true, deviceUdid: 'RUN', avdName: 'stim-run' } } },
          '/another/worktree': {
            platforms: { [platform]: { owned: true, deviceUdid: 'OTHER', avdName: 'stim-other' } },
          },
        },
      }),
    );
    f.writeState({});
    f.output.failure = 'ps';
    f.cleanup.recordWorkspace(f.cwd);
    f.output.failure = null;
    rmSync(f.configFile);
    f.cleanup.recordWorkspace(f.cwd);
    f.output.devices = [{ udid: 'RUN', name: 'stim-parked' }];
    f.output.avds = ['stim-run'];
    await assert.rejects(() => f.verify(), /a device from this run was left behind/);
    f.output.devices = [{ udid: 'OTHER', name: 'stim-other' }];
    f.output.avds = ['stim-other'];
    await f.verify();
  });

  test(`native cleanup does not claim an unowned registered ${platform} device`, async (t) => {
    const f = fixture(t, platform);
    writeFileSync(
      f.configFile,
      JSON.stringify({
        projects: {
          [f.cwd]: { platforms: { [platform]: { owned: false, deviceUdid: 'OTHER', avdName: 'personal-avd' } } },
        },
      }),
    );
    f.cleanup.recordWorkspace(f.cwd);
    f.output.devices = [{ udid: 'OTHER', name: 'personal simulator' }];
    f.output.avds = ['personal-avd'];
    await f.verify();
  });
}

test('pool counts tracked UDIDs across rename, eviction and adoption', async (t) => {
  const f = fixture(t);
  f.cleanup.recordBuild({ udid: 'FIRST' });
  f.cleanup.recordBuild({ udid: 'SECOND' });
  f.output.devices = [
    { udid: 'FIRST', name: 'stim-parked' },
    { udid: 'SECOND', name: 'stim-pool-2' },
    { udid: 'UNRELATED', name: 'stim-other' },
  ];
  assert.deepEqual(f.cleanup.remainingDevices(), ['FIRST', 'SECOND']);
  f.output.devices.shift();
  f.cleanup.recordBuild({ udid: 'SECOND' });
  f.output.devices[0].name = 'stim-pool-3';
  assert.deepEqual(f.cleanup.remainingDevices(), ['SECOND']);
  f.output.devices.shift();
  await f.verify();
});

test('native cleanup ignores unrelated supervisors when this run has no live processes', async (t) => {
  const f = fixture(t);
  f.output.processes = ' 987 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /unrelated';
  await f.verify();
});

for (const [kind, state] of [
  ['supervisor', { supervisor: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } }],
  ['Metro child', { supervisor: { serverPid: 123, startedAt: '2026-09-05T01:00:00Z' } }],
  ['collector', { collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } }],
]) {
  test(`native cleanup detects a leaked ${kind} after its state record disappears`, async (t) => {
    const f = fixture(t);
    f.writeState(state);
    f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node stim-cli ${kind} --root ${f.cwd}`;
    f.cleanup.recordWorkspace(f.cwd);
    rmSync(f.stateFile);
    f.cleanup.recordWorkspace(f.cwd);
    await assert.rejects(() => f.verify(), /a workspace process is still running/);
    f.output.processes = ' 987 Sat Sep 5 01:00:00 2026 node stim-cli supervisor --root /unrelated';
    await f.verify();
  });

  test(`native cleanup does not recapture a reused ${kind} PID from stale state`, async (t) => {
    const f = fixture(t);
    f.writeState(state);
    f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node stim-cli ${kind} --root ${f.cwd}`;
    f.cleanup.recordWorkspace(f.cwd);
    f.output.processes = ' 123 Sat Sep 5 02:00:00 2026 node stim-cli supervisor --root /unrelated';
    f.cleanup.recordWorkspace(f.cwd);
    await f.verify();
  });
}

test('native cleanup does not hide unreadable workspace state', async (t) => {
  const f = fixture(t);
  f.writeState({});
  writeFileSync(f.stateFile, '{');
  assert.throws(() => f.cleanup.recordWorkspace(f.cwd), SyntaxError);
});

test('native cleanup retains replaced collectors and ignores a reused PID with CRLF process rows', async (t) => {
  const f = fixture(t);
  f.output.crlf = true;
  const first = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  const second = ` 456 Sat Sep 5 01:01:00 2026 node collector --root ${f.cwd}`;
  f.writeState({ collectors: { android: { pid: 123 } } });
  f.output.processes = first;
  f.cleanup.recordWorkspace(f.cwd);
  f.writeState({ collectors: { android: { pid: 456 } } });
  f.output.processes = `${first}\n${second}`;
  f.cleanup.recordWorkspace(f.cwd);
  f.output.processes = first;
  await assert.rejects(() => f.verify(), /a workspace process is still running/);
  f.output.processes = first.replace('01:00:00', '02:00:00');
  await f.verify();
});

test('native cleanup tracks a new registration even when it recycles a captured PID', async (t) => {
  const f = fixture(t);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } });
  f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T02:00:00Z' } } });
  f.output.processes = ` 123 Sat Sep 5 02:00:00 2026 node collector --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  rmSync(f.stateFile);
  await assert.rejects(() => f.verify(), /a workspace process is still running/);
});

test('native cleanup does not adopt a reused PID missing from its first snapshot', async (t) => {
  const f = fixture(t);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } });
  f.cleanup.recordWorkspace(f.cwd);
  f.output.processes = ' 123 Sat Sep 5 02:00:00 2026 node stim-cli supervisor --root /unrelated';
  f.cleanup.recordWorkspace(f.cwd);
  await f.verify();
});

test('native cleanup waits for a signalled collector to exit', async (t) => {
  const f = fixture(t, 'ios', 200);
  f.writeState({ collectors: { ios: { pid: 123, startedAt: '2026-09-05T01:00:00Z' } } });
  f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node collector --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  const timer = setTimeout(() => {
    f.output.processes = '';
  }, 10);
  t.after(() => clearTimeout(timer));
  await f.verify();
  assert.ok(f.output.processReads >= 3);
});

test('native cleanup still fails a process that survives the settle window', async (t) => {
  const f = fixture(t, 'ios', 20);
  f.writeState({ supervisor: { serverPid: 123, startedAt: '2026-09-05T01:00:00Z' } });
  f.output.processes = ` 123 Sat Sep 5 01:00:00 2026 node expo --root ${f.cwd}`;
  f.cleanup.recordWorkspace(f.cwd);
  await assert.rejects(() => f.verify(), /a workspace process is still running/);
  assert.ok(f.output.processReads >= 3);
});

for (const [platform, tool] of [
  ['ios', 'xcrun'],
  ['android', 'emulator'],
  ['ios', 'ps'],
]) {
  test(`native cleanup throws when ${tool} inspection fails`, async (t) => {
    const f = fixture(t, platform);
    f.output.failure = tool;
    await assert.rejects(() => f.verify(), new RegExp(`could not inspect ${tool}: fixture inspection failed`));
  });
}

test('native cleanup refuses empty successful process inspection', async (t) => {
  const f = fixture(t);
  f.output.harnessVisible = false;
  await assert.rejects(() => f.verify(), /process inspection did not include the live harness/);
});

for (const setting of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
  test(`native cleanup finds the emulator through ${setting} without PATH`, (t) => {
    const home = mkdtempSync(join(tmpdir(), 'stim-native-sdk-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const executable = join(home, 'sdk with spaces', 'emulator', 'emulator');
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(
      executable,
      `#!${process.execPath}\nif (process.argv[2] !== '-list-avds') process.exit(2);\nconsole.log('stim-owned\\nuser-avd');\n`,
    );
    chmodSync(executable, 0o755);
    const h = createHarness({
      env: { STIM_HOME: home, PATH: '', [setting]: join(home, 'sdk with spaces') },
      cliPath: '/unused',
      label: 'sdk-inspection',
    });
    const cleanup = createCleanupTracker({ h, platform: 'android' });
    cleanup.recordBuild({ avdName: 'stim-owned' });
    assert.deepEqual(cleanup.remainingDevices(), ['stim-owned']);
    rmSync(executable);
    assert.throws(() => cleanup.remainingDevices(), /could not inspect .*emulator:.*ENOENT/);
  });
}

test('missing executables remain inspection failures with allowFail enabled', async () => {
  const h = createHarness({ env: { PATH: '' }, cliPath: '/unused', label: 'missing-inspection' });
  const result = h.sh('stim-native-cleanup-unavailable-tool', [], { allowFail: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
  const cleanup = createCleanupTracker({ h, platform: 'android', processExitTimeoutMs: 0 });
  assert.throws(() => cleanup.remainingDevices(), /could not inspect emulator:.*ENOENT/);
  await assert.rejects(() => cleanup.verifyProcesses(), /could not inspect ps:.*ENOENT/);
});

test('native cleanup preserves registry, checkout, worktree and GC checks', async (t) => {
  const f = fixture(t);
  for (const [field, text, message] of [
    ['status', f.cwd, /status still lists a removed workspace/],
    ['porcelain', ' M tracked-file', /source checkout is dirty/],
    ['worktrees', `worktree ${f.cwd}\n`, /a worktree registration survived/],
    ['gc', f.cwd, /gc reports one of our workspaces as orphaned/],
  ]) {
    f.output[field] = text;
    await assert.rejects(() => f.verify(), message);
    f.output[field] = '';
  }
  await f.verify();
});

test('a failed JSON command keeps native ownership and diagnostics available to failure cleanup', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'stim-native-failure-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const worktree = join(base, 'worktree');
  mkdirSync(home);
  mkdirSync(worktree);
  const files = [
    [join(home, 'created-devices.json'), 'ownership'],
    [join(home, 'android-failure-diagnostics.json'), 'diagnostics'],
    [join(worktree, 'package.json'), 'fixture'],
  ];
  for (const [path, content] of files) writeFileSync(path, content);
  const cliPath = join(home, 'failing-cli.mjs');
  writeFileSync(cliPath, "process.stderr.write('STIM_LAUNCH_FAILED: fixture launch failed'); process.exit(23);");
  const h = createHarness({ env: { ...process.env, STIM_HOME: home }, cliPath, label: 'failure' });
  let failure;
  assert.throws(
    () => h.cliJson(['android', '--slot', 'third', '--json'], { cwd: worktree }),
    (error) => {
      assert.match(error.message, /failed \(exit 23\).*STIM_LAUNCH_FAILED/s);
      assert.deepEqual(error.nativeCommand, { cwd: worktree, platform: 'android', slot: 'third' });
      failure = error;
      return true;
    },
  );
  cleanupTmp([worktree, home], failure);
  for (const [path, content] of files) assert.equal(readFileSync(path, 'utf-8'), content);
});

test('failed install diagnostics select the owned slot even when the last launch belongs to its sibling', (t) => {
  const f = fixture(t, 'android');
  mkdirSync(workspaceLogsDir(f.cwd), { recursive: true });
  writeFileSync(
    f.configFile,
    JSON.stringify({
      projects: { [f.cwd]: { deviceSlots: { third: { android: { owned: true, avdName: 'stim-third' } } } } },
    }),
  );
  writeFileSync(join(process.env.STIM_HOME, 'created-devices.json'), JSON.stringify({ android: ['stim-third'] }));
  writeFileSync(
    join(workspaceLogsDir(f.cwd), 'build-android.second.ndjson'),
    JSON.stringify({ event: 'launch_attempt', platform: 'android', deviceId: 'emulator-5558', appId: 'fixture.app' }) +
      '\n',
  );
  let targetName = 'stim-third';
  let consoleNewline = '\n';
  let inventoryCode = 0;
  const h = {
    env: { STIM_HOME: process.env.STIM_HOME },
    banner() {},
    log() {},
    sh(file, argv, opts) {
      assert.equal(opts.allowFail, true);
      assert(opts.timeout <= 10_000);
      if (file === 'powershell.exe') return { code: 0, stdout: '{}', stderr: '' };
      assert.equal(file, 'adb');
      if (argv[0] === 'devices')
        return {
          code: inventoryCode,
          stdout: 'List of devices attached\r\nemulator-5558\tdevice\r\nemulator-5560\tdevice\r\n',
          stderr: '',
        };
      if (argv.includes('emu'))
        return {
          code: 0,
          stdout: `${argv[1] === 'emulator-5558' ? 'stim-second' : targetName}${consoleNewline}OK${consoleNewline}`,
          stderr: '',
        };
      return { code: 0, stdout: `observed ${argv[1]}`, stderr: '' };
    },
  };
  const failure = { nativeCommand: { cwd: f.cwd, platform: 'android', slot: 'third' }, preserveNativeState: true };
  const resultPath = join(workspaceLogsDir(f.cwd), 'android-failed-command-diagnostics.json');
  for (consoleNewline of ['\n', '\r\n', '\r\r\n']) {
    dumpDiagnostics(h, [f.cwd], failure);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.error, null);
    assert.equal(result.avdName, 'stim-third');
    assert.equal(result.deviceId, 'emulator-5560');
    const guest = result.queries.filter(({ argv }) => argv.includes('logcat'));
    assert.equal(guest.length, 1);
    assert.deepEqual(guest[0].argv, ['-s', 'emulator-5560', 'logcat', '-b', 'all', '-d', '-t', '2000']);
  }
  const config = readFileSync(f.configFile, 'utf8');
  for (const invalid of ['inventory', 'transport', 'ledger', 'ownership']) {
    inventoryCode = invalid === 'inventory' ? 1 : 0;
    targetName = invalid === 'transport' ? 'foreign' : 'stim-third';
    writeFileSync(
      join(process.env.STIM_HOME, 'created-devices.json'),
      JSON.stringify({ android: invalid === 'ledger' ? [] : ['stim-third'] }),
    );
    writeFileSync(f.configFile, invalid === 'ownership' ? JSON.stringify({ projects: {} }) : config);
    dumpDiagnostics(h, [f.cwd], failure);
    const refused = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(refused.deviceId, null);
    assert.match(
      refused.error,
      /inventory unavailable|no unique verified online transport|no verified task-owned AVD assignment/,
    );
    assert.equal(
      refused.queries.some(({ argv }) => argv.includes('logcat')),
      false,
    );
    assert.equal(failure.preserveNativeState, true);
  }
});
