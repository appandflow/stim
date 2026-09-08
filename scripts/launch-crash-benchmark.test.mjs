import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  changedPathsFromGitOutputs,
  injectRootRenderCrash,
  launchCrashDiagnosis,
  launchCrashRecovery,
  launchCrashRepair,
  podfileChecksumChanges,
  launchCrashToken,
} from './launch-crash-benchmark.mjs';

describe('launch crash benchmark', () => {
  it.skipIf(process.platform === 'win32')(
    'accepts reported Stim launch and log status only when the underlying command succeeded',
    () => {
      for (const [launchCode, logCode] of [
        [0, 0],
        [7, 0],
        [0, 7],
      ]) {
        const commands = [
          ['stim ios', launchCode, ''],
          ['stim logs --errors', logCode, 'test-token RootLayout'],
        ].map(([body, code, output], index) => {
          const command = `cd /tmp && ${body}; echo "EXIT=$?"`;
          const result = spawnSync(
            '/bin/bash',
            ['-c', `stim() { printf '%s\\n' '${output}'; return ${code}; }; ${command}`],
            { encoding: 'utf8', timeout: 5000 },
          );
          expect(result.status).toBe(0);
          return {
            id: String(index),
            command,
            exitCode: result.status,
            output: result.stdout,
            endedAt: `2026-09-04T12:00:0${index + 1}Z`,
          };
        });
        expect(
          launchCrashDiagnosis(commands, { dispatchAt: '2026-09-04T12:00:00Z', token: 'test-token', arm: 'stim' })
            .valid,
        ).toBe(launchCode === 0 && logCode === 0);
      }
      for (const suffix of ['; true', '; true; echo "EXIT=$?"', '||true; echo "EXIT=$?"']) {
        for (const failedStep of [0, 1]) {
          const commands = ['stim ios', 'stim logs --errors'].map((body, index) => {
            const command = body + (index === failedStep ? suffix : '');
            const result = spawnSync(
              '/bin/bash',
              [
                '-c',
                `stim() { printf '%s\\n' 'test-token RootLayout'; return ${index === failedStep ? 7 : 0}; }; ${command}`,
              ],
              { encoding: 'utf8', timeout: 5000 },
            );
            expect(result.status).toBe(0);
            return {
              command,
              output: result.stdout,
              exitCode: result.status,
              endedAt: `2026-09-04T12:00:0${index + 1}Z`,
            };
          });
          expect(
            launchCrashDiagnosis(commands, { dispatchAt: '2026-09-04T12:00:00Z', token: 'test-token', arm: 'stim' })
              .valid,
          ).toBe(false);
        }
      }
    },
  );
  it.skipIf(process.platform === 'win32')('uses the real pipeline status when a trailing echo exits zero', () => {
    for (const [code, prefix, valid] of [
      [0, 'cd /tmp && set -o pipefail &&', true],
      [7, 'cd /tmp && set -o pipefail &&', false],
      [7, 'cd /dev/null/not-a-directory && set -o pipefail;', false],
      [7, 'cd /dev/null/not-a-directory && set -o pipefail\n', false],
    ]) {
      const command = `${prefix} npx expo run:android 2>&1 | tee /dev/null | tail -40; echo "PIPELINE_EXIT=$?"`;
      const result = spawnSync('/bin/bash', ['-c', `npx() { return ${code}; }; ${command}`], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      const diagnosis = launchCrashDiagnosis(
        [
          { command, exitCode: result.status, output: result.stdout, endedAt: '2026-09-04T12:00:01Z' },
          { command: 'adb logcat -d', exitCode: 0, output: 'test-token RootLayout', endedAt: '2026-09-04T12:00:02Z' },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token: 'test-token', arm: 'control', platform: 'android' },
      );
      expect(diagnosis.valid).toBe(valid);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'retains Stim pipefail launch pipelines with and without a status report',
    () => {
      for (const suffix of ['', '; echo "PIPELINE_EXIT=$?"']) {
        for (const code of [0, 7]) {
          const command = `set -o pipefail; stim ios | tee /dev/null${suffix}`;
          const result = spawnSync('/bin/bash', ['-c', `stim() { return ${code}; }; ${command}`], {
            encoding: 'utf8',
            timeout: 5000,
          });
          const commands = [
            { command, exitCode: result.status, output: result.stdout, endedAt: '2026-09-04T12:00:01Z' },
            {
              command: 'stim logs --errors',
              exitCode: 0,
              output: 'test-token RootLayout',
              endedAt: '2026-09-04T12:00:02Z',
            },
          ];
          expect(
            launchCrashDiagnosis(commands, { dispatchAt: '2026-09-04T12:00:00Z', token: 'test-token', arm: 'stim' })
              .valid,
          ).toBe(code === 0);
        }
      }
    },
  );

  it('accepts only checksum-row updates, not dependency changes or malformed lockfiles', () => {
    const before = `PODS:\n  - Core (1.0)\n\nSPEC CHECKSUMS:\n  Core: ${'a'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`;
    const after = before.replace('a'.repeat(40), 'b'.repeat(40));
    expect(podfileChecksumChanges(before, after)).toEqual([
      { pod: 'Core', before: 'a'.repeat(40), after: 'b'.repeat(40) },
    ]);
    expect(podfileChecksumChanges(before, before)).toEqual([]);
    for (const changed of [
      after.replace('(1.0)', '(2.0)'),
      after.replace('Core:', 'Other:'),
      after.replace('1.16.2', '1.17.0'),
      after.replace('b'.repeat(40), 'invalid'),
      after.replace('\n\nCOCOAPODS', `\n  Added: ${'c'.repeat(40)}\n\nCOCOAPODS`),
      after.replace('SPEC CHECKSUMS:', 'OTHER:'),
    ]) {
      expect(podfileChecksumChanges(before, changed)).toBeNull();
    }
  });
  it('warns on unfamiliar setup while rejecting source inspection before runtime diagnosis', () => {
    const token = launchCrashToken('managed-setup');
    const setup = { worktree: '/tmp/run', avdConfig: '/tmp/avds/Trailhead_run.avd/config.ini' };
    const copy = `set -e
run=/tmp/run
for rel in node_modules android/.gradle android/build android/app/build android/app/.cxx ios/Pods; do
  if [ -e "$rel" ]; then
    mkdir -p "$run/$(dirname "$rel")"
    rsync -a --exclude='generated/autolinking/' "$rel" "$run/$(dirname "$rel")/"
  fi
done`;
    const inputs = [
      copy,
      `printf 'no\\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n Trailhead_run -k 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a'`,
      'printenv ANDROID_AVD_HOME',
      `rg '^disk\\.dataPartition\\.size=' ${setup.avdConfig} || true`,
      '"$ANDROID_HOME/emulator/emulator" -avd Trailhead_run 2>&1 | tee /tmp/emulator.log',
      './node_modules/.bin/expo start --dev-client --port 8081 2>&1 | tee /tmp/metro.log',
      `rg '^(port\\.serial|avd\\.name|pid)=' /Users/example/Library/Caches/TemporaryItems/avd/running/pid_123.ini`,
      `"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 wait-for-device shell 'until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 1; done; getprop sys.boot_completed'`,
      '"$ANDROID_HOME/platform-tools/adb" -s emulator-5554 reverse tcp:8081 tcp:8081',
    ];
    const before = inputs.map((command, index) => ({
      id: `setup-${index}`,
      command: `/bin/zsh -lc '` + command.replaceAll("'", "'\"'\"'") + "'",
      exitCode: 0,
      startedAt: '2026-09-04T12:00:01Z',
      endedAt: '2026-09-04T12:00:02Z',
    }));
    const launch = {
      id: 'launch',
      command:
        'set -o pipefail; ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a ./node_modules/.bin/expo run:android --device emulator-5554 --no-bundler 2>&1 | tee -a /tmp/native.log',
      exitCode: 0,
      startedAt: '2026-09-04T12:00:03Z',
      endedAt: '2026-09-04T12:00:10Z',
    };
    const logs = {
      id: 'logs',
      command: 'rg -n -i -C 8 "error|exception" /tmp/metro.log',
      output: `${token}\napp/_layout.tsx:27`,
      exitCode: 0,
      startedAt: '2026-09-04T12:00:11Z',
      endedAt: '2026-09-04T12:00:12Z',
    };
    const edit = {
      id: 'config',
      command: `tool:file_change ${JSON.stringify([{ path: setup.avdConfig, kind: 'update' }])}`,
      startedAt: '2026-09-04T12:00:01Z',
    };
    const options = {
      dispatchAt: '2026-09-04T12:00:00Z',
      token,
      arm: 'control',
      platform: 'android',
      setup,
      activities: [edit],
    };
    expect(launchCrashDiagnosis([...before, launch, logs], options)).toMatchObject({
      valid: true,
      errorCaptureCommandId: 'logs',
    });
    const pipeline = {
      ...launch,
      command:
        'cd /tmp/run && set -o pipefail && npx expo run:android --no-bundler --variant debug --device emulator-5554 2>&1 | tee /tmp/native.log | tail -40; echo "PIPELINE_EXIT=$?"',
      output: 'BUILD SUCCESSFUL\nPIPELINE_EXIT=0\nShell cwd was reset to /tmp/fixture',
    };
    expect(launchCrashDiagnosis([...before, pipeline, logs], options)).toMatchObject({ valid: true });
    expect(
      launchCrashDiagnosis(
        [
          {
            ...launch,
            command:
              'set -o pipefail; { xcrun simctl launch U1 com.appandflow.trailhead; xcrun simctl openurl U1 trailhead://app; } 2>&1 | tee /tmp/launch.log',
          },
          logs,
        ],
        { ...options, platform: 'ios' },
      ),
    ).toMatchObject({ valid: true });
    for (const changed of [
      { output: 'BUILD SUCCESSFUL\nPIPELINE_EXIT=1' },
      { output: 'BUILD SUCCESSFUL' },
      { output: 'PIPELINE_EXIT=1\nPIPELINE_EXIT=0' },
      { command: pipeline.command.replace('set -o pipefail', 'set +o pipefail') },
      { command: pipeline.command.replace('npx expo', 'set +o pipefail; npx expo') },
      { command: pipeline.command.replace('; echo', '; true; echo') },
    ])
      expect(launchCrashDiagnosis([...before, { ...pipeline, ...changed }, logs], options)).toMatchObject({
        valid: false,
        reason: 'launch-crash-initial-launch-evidence-missing',
      });
    const masked = {
      ...launch,
      id: 'masked',
      command: './node_modules/.bin/expo run:android --bad-option 2>&1 | tee /tmp/native.log',
      output: 'CommandError: unsupported flag',
    };
    expect(launchCrashDiagnosis([...before, masked, logs], options)).toMatchObject({
      valid: false,
      reason: 'launch-crash-initial-launch-evidence-missing',
    });
    expect(launchCrashDiagnosis([...before, masked, launch, logs], options)).toMatchObject({
      valid: true,
      initialLaunchCommandId: 'launch',
    });
    expect(launchCrashDiagnosis([...before, launch, logs], { ...options, setup: {} })).toMatchObject({
      valid: true,
      setupWarnings: expect.arrayContaining([{ commandId: before[0].id, command: before[0].command }]),
    });
    for (const command of [
      copy.replace('rsync -a', 'cat package.json\n    rsync -a'),
      'printenv SECRET_KEY',
      './node_modules/.bin/expo start | tee /tmp/metro.log; cat package.json',
      './node_modules/.bin/expo start --port $(cat private-port) | tee /tmp/metro.log',
      'rg anything /tmp/other.avd/config.ini',
      `cat package.json ${setup.avdConfig}`,
      `rg -n . package.json ${setup.avdConfig}`,
      `tool:file_change ${JSON.stringify([{ path: '/tmp/other.avd/config.ini', kind: 'update' }])}`,
    ]) {
      expect(launchCrashDiagnosis([{ ...before[0], command, id: 'unfamiliar' }, launch, logs], options)).toMatchObject({
        valid: true,
        setupWarnings: [{ commandId: 'unfamiliar', command }],
      });
    }
    for (const command of [
      copy.replace('rsync -a', 'cat app/_layout.tsx\n    rsync -a'),
      `cat ./app/_layout.t\\sx ${setup.avdConfig}`,
      'node -e "require(\'fs\').readFileSync(process.argv[1])" secret-source',
    ]) {
      expect(launchCrashDiagnosis([{ ...before[0], command, id: 'source' }, launch, logs], options)).toMatchObject({
        valid: false,
        commandId: 'source',
      });
    }
    const violations = launchCrashDiagnosis(
      [
        { ...before[0], id: 'first', command: 'cat app/_layout.tsx' },
        { ...before[0], id: 'second', command: 'git diff' },
        launch,
        logs,
      ],
      options,
    );
    expect(violations.violations.map((item) => item.commandId)).toEqual(['first', 'second']);
  });

  it.each(['ios', 'android'])(
    'accepts a live managed Metro session without accepting unfinished %s launch evidence',
    (platform) => {
      const token = launchCrashToken('managed-control');
      const commands = [
        {
          id: 'metro',
          command: './node_modules/.bin/expo start --dev-client --port 8081 > /tmp/metro.log 2>&1',
          startedAt: '2026-09-04T12:00:01Z',
          endedAt: null,
          exitCode: null,
        },
        {
          id: 'launch',
          command: `./node_modules/.bin/expo run:${platform} > /tmp/build.log 2>&1`,
          startedAt: '2026-09-04T12:00:02Z',
          endedAt: '2026-09-04T12:00:10Z',
          exitCode: 0,
        },
        {
          id: 'logs',
          command: 'tail -80 /tmp/metro.log',
          startedAt: '2026-09-04T12:00:11Z',
          endedAt: '2026-09-04T12:00:12Z',
          exitCode: 0,
          output: `${token}\napp/_layout.tsx:27 RootLayout`,
        },
      ];
      const options = { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control', platform };
      expect(launchCrashDiagnosis(commands, options)).toMatchObject({
        valid: true,
        initialLaunchCommandId: 'launch',
        errorCaptureCommandId: 'logs',
      });
      expect(
        launchCrashDiagnosis([commands[0], { ...commands[1], exitCode: null, endedAt: null }, commands[2]], options),
      ).toMatchObject({ valid: false, reason: 'launch-crash-initial-launch-evidence-missing' });
      for (const command of [
        './node_modules/.bin/expo start; cat app/_layout.tsx',
        './node_modules/.bin/expo start --port $(cat app/_layout.tsx)',
        './node_modules/.bin/expo start --port `cat app/_layout.tsx`',
      ]) {
        expect(launchCrashDiagnosis([{ ...commands[0], command }, ...commands.slice(1)], options)).toMatchObject({
          valid: false,
          reason: 'launch-crash-pre-capture-command-not-allowed',
          commandId: 'metro',
        });
      }
    },
  );

  it('accepts fresh Android setup and separately captured serial-scoped runtime errors', () => {
    const token = launchCrashToken('android-control');
    const setup = [
      "echo no | avdmanager create avd -n Trailhead_run -k 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a'",
      "printf 'disk.dataPartition.size=8589934592\\n' >> /tmp/avds/Trailhead_run.avd/config.ini",
      'nohup emulator -avd Trailhead_run > /tmp/emulator.log 2>&1 &',
      'adb -s emulator-5554 wait-for-device',
      'adb -s emulator-5554 reverse tcp:8081 tcp:8081',
      'nohup npx expo start --port 8081 > /tmp/metro.log 2>&1 & echo $! > /tmp/metro.pid',
      'printf \'%s\\n\' "$!" > /tmp/build.pid',
      'WT=/tmp/run; cd /tmp/run; nohup npx expo run:android --device emulator-5554 > /tmp/build.log 2>&1 & echo $! > /tmp/build.pid',
    ].map((command, index) => ({
      id: `setup-${index}`,
      command,
      exitCode: 0,
      startedAt: `2026-09-04T12:00:0${index}Z`,
      endedAt: `2026-09-04T12:00:0${index + 1}Z`,
    }));
    const evidence = [
      {
        id: 'launch',
        command: 'adb -s emulator-5554 shell am start -n com.example.app/.MainActivity',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'logs',
        command: 'adb -s emulator-5554 logcat -d | rg "ReactNativeJS"',
        exitCode: 0,
        output: `${token}\napp/_layout.tsx:28 in RootLayout`,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
    ];
    const options = { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control', platform: 'android' };
    expect(launchCrashDiagnosis([...setup, ...evidence], options)).toMatchObject({
      valid: true,
      initialLaunchCommandId: 'setup-7',
      errorCaptureCommandId: 'logs',
      dispatchToDiagnosisSeconds: 12,
    });
    for (const command of [
      'avdmanager list avd; rg "throw new Error" .',
      'adb -s emulator-5554 get-state && cat app/_layout.tsx',
      'adb -s emulator-5554 logcat -d | rg "throw" .',
      'adb -s emulator-5554 logcat -d | rg "throw"; rg "throw" .',
      "printf 'disk.dataPartition.size=8589934592\\n' >> /tmp/avds/Trailhead_run.avd/config.ini; git diff",
    ]) {
      expect(launchCrashDiagnosis([{ ...setup[0], command }, ...evidence], options)).toMatchObject({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
        commandId: 'setup-0',
      });
    }
  });

  it('requires Android Stim launch before the separate error capture', () => {
    const token = launchCrashToken('android-stim');
    const commands = [
      {
        id: 'launch',
        command: "stim android --system-image 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a'",
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'logs',
        command: 'stim logs --errors',
        exitCode: 0,
        output: `${token}\nRootLayout`,
        endedAt: '2026-09-04T12:00:12Z',
      },
    ];
    const options = { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'stim', platform: 'android' };
    expect(launchCrashDiagnosis(commands, options)).toMatchObject({ valid: true });
    expect(launchCrashDiagnosis([{ ...commands[0], command: 'stim ios' }, commands[1]], options)).toMatchObject({
      valid: false,
      reason: 'launch-crash-initial-launch-evidence-missing',
    });
  });

  it('combines staged, unstaged, and untracked repair paths', () => {
    expect(changedPathsFromGitOutputs('app/_layout.tsx\0', '')).toEqual(['app/_layout.tsx']);
    expect(changedPathsFromGitOutputs('app/_layout.tsx\0', 'notes.txt\0')).toEqual(['app/_layout.tsx', 'notes.txt']);
    expect(changedPathsFromGitOutputs('src/native.ts\0app/_layout.tsx\0', 'src/native.ts\0')).toEqual([
      'app/_layout.tsx',
      'src/native.ts',
    ]);
  });

  it('injects a unique deterministic exception at the root render', () => {
    const token = launchCrashToken('sol-stim-123');
    const source = 'const value = 1;\n\nexport default function RootLayout() {\n  return value;\n}\n';

    expect(token).toMatch(/^STIM_BENCH_LAUNCH_CRASH_[0-9A-F]{12}$/);
    expect(launchCrashToken('sol-stim-123')).toBe(token);
    expect(injectRootRenderCrash(source, token)).toContain(
      `export default function RootLayout() {\n  throw new Error('${token}');\n`,
    );
  });

  it('refuses an unknown layout shape or an already injected token', () => {
    const token = launchCrashToken('run');
    expect(() => injectRootRenderCrash('export default function App() {}', token)).toThrow(
      'RootLayout function was not found',
    );
    expect(() => injectRootRenderCrash(`export default function RootLayout() {\n  // ${token}\n}`, token)).toThrow(
      'launch-crash token is already present',
    );
  });

  it('waits past empty logs and UI-only errors for token-bearing log evidence', () => {
    const token = launchCrashToken('run');
    const diagnosis = launchCrashDiagnosis(
      [
        {
          id: 'launch',
          command: 'stim ios',
          output: 'launch com.example.app\n1 error-level record during launch (logs --errors --source device)',
          exitCode: 0,
          startedAt: '2026-09-04T12:00:01.000Z',
          endedAt: '2026-09-04T12:00:10.000Z',
        },
        {
          id: 'empty-logs',
          command: 'stim logs --errors',
          output: 'No matching log records',
          exitCode: 0,
          startedAt: '2026-09-04T12:00:10.100Z',
          endedAt: '2026-09-04T12:00:10.200Z',
        },
        {
          id: 'redbox',
          command: 'agent-device snapshot -i',
          output: `${token}\napp/_layout.tsx:28 in RootLayout`,
          exitCode: 0,
          startedAt: '2026-09-04T12:00:10.300Z',
          endedAt: '2026-09-04T12:00:10.400Z',
        },
        {
          id: 'empty-logs-retry',
          command: 'stim logs --errors',
          output: 'No matching log records',
          exitCode: 0,
          startedAt: '2026-09-04T12:00:10.500Z',
          endedAt: '2026-09-04T12:00:10.600Z',
        },
        {
          id: 'logs',
          command: 'stim logs --errors',
          output: `${token}\napp/_layout.tsx:28 in RootLayout`,
          exitCode: 0,
          startedAt: '2026-09-04T12:00:11.000Z',
          endedAt: '2026-09-04T12:00:15.000Z',
        },
      ],
      { dispatchAt: '2026-09-04T12:00:00.000Z', token },
    );

    expect(diagnosis).toEqual({
      valid: true,
      observedAt: '2026-09-04T12:00:15.000Z',
      dispatchToDiagnosisSeconds: 15,
      commandCount: 5,
      commandId: 'logs',
      command: 'stim logs --errors',
      initialLaunchCommandId: 'launch',
      errorCaptureCommandId: 'logs',
    });
  });

  it('rejects source inspection before launch and error capture', () => {
    const token = launchCrashToken('run');
    const commands = [
      {
        id: 'inspect',
        command: "node -e \"console.log(require('fs').readFileSync('app/_layout.tsx', 'utf8'))\"",
        output: `${token}\napp/_layout.tsx:28 in RootLayout`,
        exitCode: 0,
        endedAt: '2026-09-04T12:00:01.000Z',
      },
      {
        id: 'launch',
        command: 'stim ios',
        output: token,
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10.000Z',
      },
      {
        id: 'logs',
        command: 'stim logs --errors',
        output: token,
        exitCode: 0,
        endedAt: '2026-09-04T12:00:15.000Z',
      },
    ];

    expect(launchCrashDiagnosis(commands, { dispatchAt: '2026-09-04T12:00:00.000Z', token })).toEqual({
      valid: false,
      reason: 'launch-crash-pre-capture-command-not-allowed',
      commandId: 'inspect',
      violations: [{ commandId: 'inspect', command: commands[0].command }],
    });
  });

  it('allows current Stim setup and narrow dependency resolution before separately captured errors', () => {
    const token = launchCrashToken('setup');
    const setup = [
      'stim guide agent',
      'git worktree add -b bench/run /tmp/bench-run HEAD',
      'stim worktree warm',
      'stim doctor --platform ios',
      `node -p "require.resolve('expo/package.json')" && node_modules/.bin/expo --version`,
    ].map((command, index) => ({
      id: `setup-${index}`,
      command: `/bin/zsh -lc ${JSON.stringify(command)}`,
      exitCode: 0,
      endedAt: `2026-09-04T12:00:0${index + 1}Z`,
    }));
    const evidence = [
      {
        id: 'launch',
        command: 'stim ios',
        output: 'launched com.example.app',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'logs',
        command: 'stim logs --errors',
        output: `${token}\napp/_layout.tsx in RootLayout`,
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
    ];
    const options = { dispatchAt: '2026-09-04T12:00:00Z', token };
    expect(launchCrashDiagnosis([...setup, ...evidence], options)).toMatchObject({
      valid: true,
      commandId: 'logs',
      dispatchToDiagnosisSeconds: 12,
    });
    for (const command of [
      `node -p "require('fs').readFileSync('app/_layout.tsx', 'utf8')"`,
      `node -p "require.resolve('expo/package.json'); require('./app/_layout.tsx')"`,
      'stim guide agent && cat app/_layout.tsx',
      'stim doctor --platform ios; git diff',
      'stim guide agent && rg "throw new Error" .',
      'stim doctor --platform ios; rg "throw new Error" .',
      'stim worktree warm | rg "throw new Error" .',
      'rsync -a node_modules /tmp/wt/ && rg "throw new Error" .',
    ]) {
      expect(launchCrashDiagnosis([{ ...setup[0], command }, ...evidence], options)).toMatchObject({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
        commandId: 'setup-0',
      });
    }
    expect(
      launchCrashDiagnosis([...setup, evidence[0], { ...evidence[1], output: 'unrelated error' }], options),
    ).toMatchObject({ valid: false, reason: 'launch-crash-error-capture-missing' });
  });

  it('rejects source inspection hidden after an allowed compound-command prefix', () => {
    const token = launchCrashToken('run');
    const tail = [
      {
        id: 'launch',
        command: 'stim ios',
        output: token,
        exitCode: 0,
        startedAt: '2026-09-04T12:00:02.000Z',
        endedAt: '2026-09-04T12:00:10.000Z',
      },
      {
        id: 'logs',
        command: 'stim logs --errors',
        output: `${token}\napp/_layout.tsx in RootLayout`,
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11.000Z',
        endedAt: '2026-09-04T12:00:15.000Z',
      },
    ];

    for (const command of ["pwd && sed -n '1,80p' app/secret.tsx", 'git status && git diff']) {
      expect(
        launchCrashDiagnosis(
          [
            {
              id: 'inspect',
              command,
              output: 'source',
              exitCode: 0,
              startedAt: '2026-09-04T12:00:01.000Z',
              endedAt: '2026-09-04T12:00:01.500Z',
            },
            ...tail,
          ],
          { dispatchAt: '2026-09-04T12:00:00.000Z', token },
        ),
      ).toEqual({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
        commandId: 'inspect',
        violations: [{ commandId: 'inspect', command }],
      });
    }
  });

  it('allows planning activity before the first error capture', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'launch',
            command: 'stim ios',
            output: token,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:02.000Z',
            endedAt: '2026-09-04T12:00:10.000Z',
          },
          {
            id: 'logs',
            command: 'stim logs --errors',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11.000Z',
            endedAt: '2026-09-04T12:00:15.000Z',
          },
        ],
        {
          dispatchAt: '2026-09-04T12:00:00.000Z',
          token,
          activities: [
            {
              id: 'plan',
              command: 'tool:todo_list {}',
              startedAt: '2026-09-04T12:00:01.000Z',
              endedAt: '2026-09-04T12:00:01.000Z',
            },
          ],
        },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows dependency copying and PID/log diagnostics without treating source reads as logs', () => {
    const token = launchCrashToken('control-setup');
    const setup = [
      'rsync -aR node_modules ios/Pods ios/build /tmp/worktree/',
      './node_modules/.bin/expo --version',
      'node -p process.execPath',
      'pgrep -P 35182 -fl .',
      'print -r -- 35182 | tee /tmp/run-metro.pid',
      "sed -n '1,160p' /tmp/run-metro.log",
    ].map((command, index) => ({
      id: `setup-${index}`,
      command,
      exitCode: 0,
      endedAt: `2026-09-04T12:00:0${index + 1}Z`,
    }));
    const launch = {
      id: 'launch',
      command: 'npx expo run:ios --device SIMULATOR',
      output: 'launched',
      exitCode: 0,
      endedAt: '2026-09-04T12:00:10Z',
    };
    const logs = {
      id: 'logs',
      command: "sed -n '1,160p' /tmp/run-runtime.log",
      output: `${token}\napp/_layout.tsx in RootLayout`,
      exitCode: 0,
      startedAt: '2026-09-04T12:00:11Z',
      endedAt: '2026-09-04T12:00:12Z',
    };
    const options = { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' };
    expect(launchCrashDiagnosis([...setup, launch, logs], options)).toMatchObject({ valid: true, commandId: 'logs' });
    for (const command of [
      'pgrep -fl Metro && rg "throw new Error" .',
      'sed -n "1,160p" /tmp/run-metro.log && rg "throw new Error" .',
      'cat /tmp/run-metro.log; rg "throw new Error" .',
    ]) {
      expect(launchCrashDiagnosis([{ ...setup[0], command }, launch, logs], options)).toMatchObject({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
      });
    }
    expect(
      launchCrashDiagnosis([launch, { ...logs, command: "sed -n '1,160p' app/_layout.tsx" }], options),
    ).toMatchObject({ valid: false, reason: 'launch-crash-error-capture-missing' });
    expect(
      launchCrashDiagnosis([launch, { ...logs, command: 'cat app/_layout.tsx /tmp/run-runtime.log' }], options),
    ).toMatchObject({ valid: false, reason: 'launch-crash-pre-capture-command-not-allowed' });
  });

  it('unwraps a shell command whose nested quoting changes the closing quote', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'metro',
            command:
              '/bin/zsh -lc "nohup ./node_modules/.bin/expo start > /tmp/metro.log 2>&1 & pid="\'$!; echo "$pid"\'',
            output: '1234',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01.000Z',
            endedAt: '2026-09-04T12:00:02.000Z',
          },
          {
            id: 'launch',
            command: '/opt/homebrew/bin/node ./node_modules/expo/bin/cli run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03.000Z',
            endedAt: '2026-09-04T12:00:10.000Z',
          },
          {
            id: 'logs',
            command: 'tail /tmp/native.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11.000Z',
            endedAt: '2026-09-04T12:00:15.000Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00.000Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows isolated device interaction needed to expose the runtime error', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01.000Z',
            endedAt: '2026-09-04T12:00:10.000Z',
          },
          {
            id: 'device',
            command:
              'env AGENT_DEVICE_STATE_DIR=/tmp/state AGENT_DEVICE_SESSION=run agent-device click "Enter URL manually"',
            output: 'clicked',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11.000Z',
            endedAt: '2026-09-04T12:00:12.000Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH /tmp/metro.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:13.000Z',
            endedAt: '2026-09-04T12:00:15.000Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00.000Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows directory-only dependency and native-cache inventory before launch diagnosis', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'inventory',
            command:
              'find . -maxdepth 3 -type d \\( -name node_modules -o -name Pods -o -name build -o -name .gradle -o -name DerivedData \\) -print',
            output: './node_modules\n./ios/Pods\n./ios/build',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01Z',
            endedAt: '2026-09-04T12:00:02Z',
          },
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03Z',
            endedAt: '2026-09-04T12:00:10Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH logs/runtime.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11Z',
            endedAt: '2026-09-04T12:00:12Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows iOS project-container discovery before launch diagnosis', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'inventory',
            command: "find ios -maxdepth 1 \\( -name '*.xcworkspace' -o -name '*.xcodeproj' \\) -print",
            output: 'ios/Trailhead.xcworkspace\nios/Trailhead.xcodeproj',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01Z',
            endedAt: '2026-09-04T12:00:02Z',
          },
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03Z',
            endedAt: '2026-09-04T12:00:10Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH logs/runtime.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11Z',
            endedAt: '2026-09-04T12:00:12Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('allows installed iOS URL-scheme discovery before launch diagnosis', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          {
            id: 'scheme',
            command:
              'app_container=$(xcrun simctl get_app_container SIMULATOR com.example.app app); plutil -p "$app_container/Info.plist" | rg -A 8 CFBundleURLSchemes',
            output: 'CFBundleURLSchemes => [ trailhead ]',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:01Z',
            endedAt: '2026-09-04T12:00:02Z',
          },
          {
            id: 'launch',
            command: 'npx expo run:ios --device SIMULATOR',
            output: 'started',
            exitCode: 0,
            startedAt: '2026-09-04T12:00:03Z',
            endedAt: '2026-09-04T12:00:10Z',
          },
          {
            id: 'logs',
            command: 'rg STIM_BENCH logs/runtime.log',
            output: `${token}\napp/_layout.tsx in RootLayout`,
            exitCode: 0,
            startedAt: '2026-09-04T12:00:11Z',
            endedAt: '2026-09-04T12:00:12Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
      ),
    ).toMatchObject({ valid: true, commandId: 'logs' });
  });

  it('does not accept source searches as control error capture', () => {
    const token = launchCrashToken('run');
    for (const command of [`rg ${token} app/_layout.tsx`, `rg ${token} .`]) {
      expect(
        launchCrashDiagnosis(
          [
            {
              id: 'launch',
              command: 'npx expo run:ios --device SIMULATOR',
              output: 'started',
              exitCode: 0,
              endedAt: '2026-09-04T12:00:10Z',
            },
            {
              id: 'source',
              command,
              output: `${token}\napp/_layout.tsx in RootLayout`,
              exitCode: 0,
              startedAt: '2026-09-04T12:00:11Z',
              endedAt: '2026-09-04T12:00:12Z',
            },
          ],
          { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
        ),
      ).toEqual({ valid: false, reason: 'launch-crash-error-capture-missing' });
    }
  });

  it('rejects mixed log-capture and source-inspection commands', () => {
    const token = launchCrashToken('run');
    for (const command of [
      `rg ${token} app/_layout.tsx tmp/runtime.log`,
      'cat app/_layout.tsx; tail tmp/runtime.log',
    ]) {
      expect(
        launchCrashDiagnosis(
          [
            {
              id: 'launch',
              command: 'npx expo run:ios --device SIMULATOR',
              output: 'started',
              exitCode: 0,
              startedAt: '2026-09-04T12:00:01Z',
              endedAt: '2026-09-04T12:00:10Z',
            },
            {
              id: 'mixed',
              command,
              output: `${token}\napp/_layout.tsx in RootLayout`,
              exitCode: 0,
              startedAt: '2026-09-04T12:00:11Z',
              endedAt: '2026-09-04T12:00:12Z',
            },
          ],
          { dispatchAt: '2026-09-04T12:00:00Z', token, arm: 'control' },
        ),
      ).toEqual({
        valid: false,
        reason: 'launch-crash-pre-capture-command-not-allowed',
        commandId: 'mixed',
        violations: [{ commandId: 'mixed', command }],
      });
    }
  });

  it('requires an explicit zero exit code for diagnosis and screenshot proof', () => {
    const token = launchCrashToken('run');
    const launch = {
      id: 'launch',
      command: 'stim ios',
      output: token,
      exitCode: 0,
      endedAt: '2026-09-04T12:00:10Z',
    };
    const logs = {
      id: 'logs',
      command: 'stim logs --errors',
      output: token,
      exitCode: 0,
      startedAt: '2026-09-04T12:00:11Z',
      endedAt: '2026-09-04T12:00:12Z',
    };
    const diagnosis = {
      id: 'diagnosis',
      command: 'rg token logs/runtime.log',
      output: `${token}\napp/_layout.tsx in RootLayout`,
      exitCode: 0,
      startedAt: '2026-09-04T12:00:13Z',
      endedAt: '2026-09-04T12:00:14Z',
    };
    expect(
      launchCrashDiagnosis([{ ...launch, exitCode: null }, logs, diagnosis], {
        dispatchAt: '2026-09-04T12:00:00Z',
        token,
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-initial-launch-evidence-missing' });
    expect(
      launchCrashDiagnosis([launch, { ...logs, exitCode: undefined }, diagnosis], {
        dispatchAt: '2026-09-04T12:00:00Z',
        token,
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-error-capture-missing' });
    expect(
      launchCrashDiagnosis([launch, logs, { ...diagnosis, exitCode: null }], {
        dispatchAt: '2026-09-04T12:00:00Z',
        token,
      }),
    ).toEqual({ valid: false, reason: 'actionable-launch-crash-diagnosis-missing' });

    const validDiagnosis = { valid: true, commandId: 'diagnosis' };
    const screenshot = {
      id: 'screenshot',
      command: 'agent-device screenshot /tmp/settings.png',
      output: 'saved',
      exitCode: 0,
      startedAt: '2026-09-04T12:00:21Z',
      endedAt: '2026-09-04T12:00:22Z',
    };
    const screen = { valid: true, observedAt: screenshot.endedAt, screenshotCommandId: screenshot.id };
    expect(
      launchCrashRecovery([diagnosis, { ...screenshot, exitCode: undefined }], {
        diagnosis: validDiagnosis,
        screen,
      }),
    ).toEqual({ valid: false, reason: 'launch-crash-settings-command-invalid' });
  });

  it('requires Settings proof after diagnosis without prescribing recovery', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'rg TOKEN app/_layout.tsx',
        output: 'app/_layout.tsx',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:09Z',
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
    ];
    expect(launchCrashRecovery(commands, { diagnosis, screen: { valid: false } })).toEqual({
      valid: false,
      reason: 'launch-crash-settings-proof-missing',
    });
    expect(
      launchCrashRecovery(
        [
          commands[0],
          {
            ...commands[1],
            startedAt: '2026-09-04T12:00:08Z',
            endedAt: '2026-09-04T12:00:09Z',
          },
        ],
        {
          diagnosis,
          screen: { valid: true, observedAt: '2026-09-04T12:00:09Z', screenshotCommandId: 'screenshot' },
        },
      ),
    ).toEqual({ valid: false, reason: 'launch-crash-settings-proof-before-diagnosis' });
    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: { valid: true, observedAt: '2026-09-04T12:00:12Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({
      valid: true,
      screenshotCommandId: 'screenshot',
    });
  });

  it('accepts a second Stim platform run when it reaches valid proof', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'stim logs --errors',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'second-ios',
        command: 'stim ios',
        output: 'OK: com.example.app',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:20Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:21Z',
        endedAt: '2026-09-04T12:00:22Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: {
          valid: true,
          observedAt: '2026-09-04T12:00:22Z',
          screenshotCommandId: 'screenshot',
        },
      }),
    ).toEqual({ valid: true, screenshotCommandId: 'screenshot' });
  });

  it('accepts a control Metro reload when later Settings proof succeeds', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'rg TOKEN app/_layout.tsx',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'reload',
        command: 'agent-device metro reload --metro-port 8081',
        output: 'Reload broadcast sent',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:20Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:20.500Z',
        endedAt: '2026-09-04T12:00:21Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        arm: 'control',
        screen: { valid: true, observedAt: '2026-09-04T12:00:21Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: true, screenshotCommandId: 'screenshot' });
  });

  it('accepts valid proof without recognizing a recovery command', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'tail logs/initial.log',
        output: 'STIM_BENCH_LAUNCH_CRASH_TOKEN app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'reload',
        command: 'agent-device metro reload',
        output: 'Reload broadcast sent',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:13Z',
        endedAt: '2026-09-04T12:00:14Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        arm: 'control',
        screen: { valid: true, observedAt: '2026-09-04T12:00:14Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: true, screenshotCommandId: 'screenshot' });
  });

  it('does not make recovery command shape a validity condition', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'stim logs --errors',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'reload',
        command: 'agent-device metro reload --metro-port 65535 || true',
        output: 'No Metro server is listening',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:13Z',
        endedAt: '2026-09-04T12:00:14Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        screen: {
          valid: true,
          observedAt: '2026-09-04T12:00:14Z',
          screenshotCommandId: 'screenshot',
        },
      }),
    ).toEqual({ valid: true, screenshotCommandId: 'screenshot' });
  });

  it('uses the final screen proof instead of inferring recovery from command output', () => {
    const diagnosis = { valid: true, commandId: 'diagnosis' };
    const commands = [
      {
        id: 'diagnosis',
        command: 'rg token logs/runtime.log',
        output: 'app/_layout.tsx',
        exitCode: 0,
        endedAt: '2026-09-04T12:00:10Z',
      },
      {
        id: 'reload',
        command: 'agent-device metro reload --metro-port 8081',
        output: 'Reload broadcast sent',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:11Z',
        endedAt: '2026-09-04T12:00:12Z',
      },
      {
        id: 'crash',
        command: 'tail logs/runtime.log',
        output: 'STIM_BENCH_LAUNCH_CRASH_ABCDEF123456',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:13Z',
        endedAt: '2026-09-04T12:00:14Z',
      },
      {
        id: 'screenshot',
        command: 'agent-device screenshot /tmp/settings.png',
        output: 'saved',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:15Z',
        endedAt: '2026-09-04T12:00:16Z',
      },
    ];

    expect(
      launchCrashRecovery(commands, {
        diagnosis,
        arm: 'control',
        screen: { valid: true, observedAt: '2026-09-04T12:00:16Z', screenshotCommandId: 'screenshot' },
      }),
    ).toEqual({ valid: true, screenshotCommandId: 'screenshot' });
  });

  it('rejects generic errors and verifies that the injected source was restored', () => {
    const token = launchCrashToken('run');
    expect(
      launchCrashDiagnosis(
        [
          { id: 'launch', command: 'stim ios', output: token, exitCode: 0, endedAt: '2026-09-04T12:00:10Z' },
          {
            id: 'logs',
            command: 'stim logs --errors',
            output: 'Generic error',
            exitCode: 0,
            endedAt: '2026-09-04T12:00:15Z',
          },
        ],
        { dispatchAt: '2026-09-04T12:00:00Z', token },
      ),
    ).toEqual({ valid: false, reason: 'launch-crash-error-capture-missing' });
    expect(launchCrashRepair(`throw new Error('${token}')`, token)).toEqual({
      valid: false,
      reason: 'launch-crash-token-remains-in-source',
    });
    expect(launchCrashRepair('', token)).toEqual({
      valid: false,
      reason: 'launch-crash-repaired-source-empty',
    });
    const source = 'return <App />;';
    const sourceSha256 = '536c73d86cc5b77dc1a134a6d90687ec5c9c848e67beadf8ff45cdd2da649908';
    expect(launchCrashRepair(source, token, sourceSha256)).toEqual({ valid: true, sourceSha256 });
    expect(launchCrashRepair(`${source}\n`, token, sourceSha256)).toMatchObject({
      valid: false,
      reason: 'launch-crash-source-not-restored',
    });
  });
});
