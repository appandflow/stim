import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  backgroundProcessesFor,
  benchmarkEnvironment,
  estimateTokenCost,
  eventsFor,
  exportBenchmark,
  sanitizeBenchmarkText,
  sanitizeCommandOutput,
  summarizeRun,
} from './export-benchmark-viewer.mjs';

const tempDirs = [];

function stamp(arrivedAt, event) {
  return JSON.stringify({ arrivedAt, stream: 'stdout', line: JSON.stringify(event) });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('benchmark viewer export', () => {
  it('extends detached processes through commands that monitor their PID or PID file', () => {
    const commands = [
      {
        id: 'wrong-launch',
        startSeconds: 1,
        endSeconds: 1.1,
        command: 'nohup npx expo run:ios --udid U1 > tmp/build.log 2>&1 &\necho $! > tmp/build.pid',
        output: '1001',
        exitCode: 0,
      },
      {
        id: 'wrong-check',
        startSeconds: 2,
        endSeconds: 3,
        command: 'ps -p 1001; cat tmp/build.pid',
        output: '',
        exitCode: 0,
      },
      {
        id: 'launch',
        startSeconds: 4,
        endSeconds: 4.1,
        command: 'nohup npx expo run:ios --device U1 > tmp/run.log 2>&1 &\necho $! > tmp/build.pid',
        output: 'PID=2002',
        exitCode: 0,
      },
      {
        id: 'poll',
        startSeconds: 10,
        endSeconds: 20,
        command: 'ps -p 2002; tail tmp/run.log',
        output: '',
        exitCode: 0,
      },
    ];

    expect(backgroundProcessesFor(commands)).toEqual([
      {
        id: 'background-wrong-launch',
        label: 'npx expo run:ios --udid U1',
        startSeconds: 1.1,
        endSeconds: 3,
        launcherCommandId: 'wrong-launch',
        monitorCount: 1,
      },
      {
        id: 'background-launch',
        label: 'npx expo run:ios --device U1',
        startSeconds: 4.1,
        endSeconds: 20,
        launcherCommandId: 'launch',
        monitorCount: 1,
      },
    ]);
  });

  it('omits detached launchers without an identifier or later monitoring evidence', () => {
    expect(
      backgroundProcessesFor([
        {
          id: 'no-identifier',
          startSeconds: 0,
          endSeconds: 1,
          command: 'nohup npx expo start > tmp/metro.log 2>&1 &',
          output: '',
          exitCode: 0,
        },
        {
          id: 'not-monitored',
          startSeconds: 2,
          endSeconds: 3,
          command: 'nohup npx expo start > tmp/metro.log 2>&1 &\necho $! > tmp/metro.pid',
          output: '3003',
          exitCode: 0,
        },
      ]),
    ).toEqual([]);
  });

  it('does not treat PID cleanup or incidental numbers as process monitoring', () => {
    expect(
      backgroundProcessesFor([
        {
          id: 'launch',
          startSeconds: 0,
          endSeconds: 1,
          command: 'nohup npx expo start > tmp/metro.log 2>&1 &\necho $! > tmp/metro.pid',
          output: '4004',
          exitCode: 0,
        },
        {
          id: 'incidental',
          startSeconds: 2,
          endSeconds: 3,
          command: 'echo "build 4004 finished"',
          output: '',
          exitCode: 0,
        },
        {
          id: 'cleanup',
          startSeconds: 4,
          endSeconds: 5,
          command: 'rm tmp/metro.pid',
          output: '',
          exitCode: 0,
        },
      ]),
    ).toEqual([]);
  });

  it('summarizes the recorded preparation, launcher, proof, and failed attempts', () => {
    const commands = [
      {
        id: 'worktree',
        startSeconds: 0,
        endSeconds: 1,
        command: 'git worktree add worktree/native-control',
        output: '',
        exitCode: 0,
      },
      {
        id: 'launch',
        startSeconds: 2,
        endSeconds: 3,
        command: 'nohup npx expo run:ios --device U1 > tmp/run.log 2>&1 &',
        output: '2002',
        exitCode: 0,
      },
      {
        id: 'monitor',
        startSeconds: 3.1,
        endSeconds: 3.5,
        command: 'ps -p 2002',
        output: '',
        exitCode: 0,
      },
      {
        id: 'proof',
        startSeconds: 4,
        endSeconds: 5,
        command: 'agent-device screenshot proof.png',
        output: '',
        exitCode: 1,
      },
    ];

    expect(
      summarizeRun({ variant: 'native', screen: { valid: true } }, commands, backgroundProcessesFor(commands)),
    ).toBe(
      'Created an isolated worktree, worked on the native iOS change, and started the local Expo/Xcode workflow. It started one process with nohup and monitored the detached work through later commands. The record includes 1 failed command attempt before completion.',
    );
  });

  it('uses neutral wording when no successful build command is recorded', () => {
    const commands = [
      {
        id: 'open',
        startSeconds: 0,
        endSeconds: 1,
        command: 'agent-device open com.example.app --platform ios --udid U1',
        output: '',
        exitCode: 0,
      },
      {
        id: 'failed-proof',
        startSeconds: 1,
        endSeconds: 2,
        command: 'agent-device screenshot proof.png',
        output: '',
        exitCode: 1,
      },
    ];

    expect(summarizeRun({ variant: 'native', screen: { valid: false } }, commands, [])).toBe(
      'Prepared the benchmark workspace, worked on the native iOS change, and opened the app with agent-device. The record includes 1 failed command attempt before completion.',
    );
  });

  it('uses the recorded platform in native summaries', () => {
    expect(
      summarizeRun(
        { variant: 'native', platform: 'android', screen: { valid: true } },
        [
          {
            id: 'launch',
            startSeconds: 0,
            endSeconds: 1,
            command: 'stim android',
            output: '',
            exitCode: 0,
          },
        ],
        [],
      ),
    ).toBe("Prepared the benchmark workspace, worked on the native Android change, and ran Stim's Android workflow.");
  });

  it('preserves a failed Claude Bash exit code when reconstructing events', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-claude-events-'));
    tempDirs.push(root);
    writeFileSync(
      join(root, 'events.jsonl'),
      `${[
        stamp('2026-09-04T12:00:01.000Z', {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'failed', name: 'Bash', input: { command: 'npx expo run:ios' } }],
          },
        }),
        stamp('2026-09-04T12:00:02.000Z', {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'failed', content: 'failed' }] },
          tool_use_result: { exit_code: 1 },
        }),
      ].join('\n')}\n`,
    );

    expect(eventsFor(root, '2026-09-04T12:00:00.000Z', []).commands[0].exitCode).toBe(1);
  });

  it('summarizes a Stim-assisted launch-failure diagnosis separately from a normal change', () => {
    const commands = [
      {
        id: 'launch',
        startSeconds: 1,
        endSeconds: 10,
        command: 'stim ios',
        output: 'ERROR launch crash',
        exitCode: 0,
      },
      {
        id: 'logs',
        startSeconds: 11,
        endSeconds: 12,
        command: 'stim logs --errors',
        output: 'ERROR launch crash',
        exitCode: 0,
      },
    ];

    expect(summarizeRun({ variant: 'launch-crash', screen: { valid: false } }, commands, [])).toBe(
      "Prepared the benchmark workspace, worked on the JavaScript launch failure, and ran Stim's iOS workflow. It used the captured Stim error log to identify the injected failure before repairing it.",
    );
  });

  it('replaces machine paths, run ids, and simulator ids', () => {
    const source =
      '/Volumes/ExternalSSD/Developer/bench/results/run-123/proof/settings.png ' +
      '/tmp/run-123-settings.png 3372C014-23D1-4939-ABF6-94912654C56E 10.0.0.188 [::1] ' +
      'com.janic.agentdevice.runner.uitests.xctrunner';
    const output = sanitizeBenchmarkText(source, [
      ['/Volumes/ExternalSSD/Developer/bench/results/run-123', 'results/luna/javascript-stim'],
      ['run-123', 'javascript-stim'],
    ]);

    expect(output).toBe(
      'results/luna/javascript-stim/proof/settings.png tmp/javascript-stim-settings.png <simulator-udid> <local-ip> <local-ip> <agent-device-helper>',
    );
  });

  it('redacts both the label and target of a Markdown path link', () => {
    const path = '/Volumes/ExternalSSD/Developer/stim-bench/worktrees/native-control';

    expect(sanitizeBenchmarkText(`[${path}](${path})`)).toBe('[worktree/native-control](worktree/native-control)');
  });

  it('makes user-home paths relative before replacing the username', () => {
    const username = userInfo().username;

    expect(sanitizeBenchmarkText(`/Users/${username}/.agent-device/sessions/example`)).toBe('workspace/example');
  });

  it('removes Homebrew executables and shell search paths', () => {
    expect(
      sanitizeBenchmarkText(
        'PATH=/opt/homebrew/bin:/usr/bin /opt/homebrew/bin/node ./node_modules/expo/bin/cli run:ios',
      ),
    ).toBe('PATH=<toolchain-path> node ./node_modules/expo/bin/cli run:ios');
  });

  it('redacts absolute compiler paths attached to flags', () => {
    expect(
      sanitizeBenchmarkText(
        '-L/Volumes/ExternalSSD/Developer/bench/worktrees/native-control/DerivedData/Build/Products',
      ),
    ).toBe('-Lworktree/native-control/DerivedData/Build/Products');
  });

  it('redacts absolute paths embedded in generated build paths', () => {
    expect(sanitizeBenchmarkText('node_modules/module.dir/Volumes/ExternalSSD/Developer/project/source.cpp.o')).toBe(
      'node_modules/module.dir/workspace/source.cpp.o',
    );
  });

  it('preserves web URLs while redacting nested machine paths', () => {
    expect(
      sanitizeBenchmarkText(
        'https://example.com/Volumes/docs See (https://example.com/Volumes/docs) ' +
          '[docs](https://example.com/Users/guide) url=https://example.com/Volumes/docs ' +
          'https://example.com/docs;/Volumes/public https://example.com/a,/Users/public ' +
          'https://example.com/a(/Volumes/public) https://example.com/a[/Users/public] ' +
          'HTTPS://example.com/Volumes/docs ' +
          'module.dir/Volumes/ExternalSSD/private.cpp',
      ),
    ).toBe(
      'https://example.com/Volumes/docs See (https://example.com/Volumes/docs) ' +
        '[docs](https://example.com/Users/guide) url=https://example.com/Volumes/docs ' +
        'https://example.com/docs;/Volumes/public https://example.com/a,/Users/public ' +
        'https://example.com/a(/Volumes/public) https://example.com/a[/Users/public] ' +
        'HTTPS://example.com/Volumes/docs ' +
        'module.dir/workspace/private.cpp',
    );
  });

  it('applies private replacements inside preserved web URLs', () => {
    const root = '/Volumes/ExternalSSD/results/private-run';
    expect(
      sanitizeBenchmarkText(`https://example.test/open?path=${root}/proof/settings.png`, [
        [root, 'results/luna-android/javascript-stim'],
        ['private-run', 'javascript-stim'],
      ]),
    ).toBe('https://example.test/open?path=results/luna-android/javascript-stim/proof/settings.png');
  });

  it('redacts ADB public keys from emulator logs and boot arguments', () => {
    const key = 'A'.repeat(96);
    expect(
      sanitizeBenchmarkText(`Sending adb public key [${key} developer@host] androidboot.qemu.adb.pubkey=${key}`),
    ).toBe('Sending adb public key [<adb-public-key>] androidboot.qemu.adb.pubkey=<adb-public-key>');
  });

  it('makes Xcode, system-tool, and root-relative build paths portable', () => {
    expect(
      sanitizeBenchmarkText(
        '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang ' +
          '/usr/bin/screen /bin/sh /Library/Frameworks/universal ' +
          '/Pods.build/Debug-iphonesimulator/App.build/object.o /XPCServices',
      ),
    ).toBe(
      'Xcode/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang screen sh ' +
        'system/Library/Frameworks/universal build/Pods.build/Debug-iphonesimulator/App.build/object.o ' +
        'app/XPCServices',
    );
  });

  it('does not mistake ordinary slash-prefixed words for filesystem roots', () => {
    expect(sanitizeBenchmarkText('/variant /options /variable /optional')).toBe(
      '/variant /options /variable /optional',
    );
  });

  it('keeps redacted simulator containers as path segments before sanitizing roots', () => {
    const udid = 'A35AFE7E-06D9-4E4B-A14D-0451595A13BC';
    const appId = 'B35AFE7E-06D9-4E4B-A14D-0451595A13BC';
    const paths =
      `/Users/alice/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Data/Application/${appId}/Library/HTTPStorages/example.app ` +
      `worktree/project/${appId}/Library/data /System/Library/EventTimingProfiles/Sim.Touch.plist`;
    expect(sanitizeBenchmarkText(paths, [[udid, '<simulator-udid>']])).toBe(
      'workspace/example.app worktree/project/simulator-udid/Library/data system/System/Library/EventTimingProfiles/Sim.Touch.plist',
    );
    expect(sanitizeBenchmarkText(`--udid ${udid}`, [[udid, '<simulator-udid>']])).toBe('--udid <simulator-udid>');
  });

  it('preserves URL path separators while sanitizing hosts', () => {
    expect(sanitizeBenchmarkText('http://127.0.0.1:8081/tmp/foo')).toBe('http://<local-ip>:8081/tmp/foo');
    expect(sanitizeBenchmarkText('https://example.com/opt/page')).toBe('https://example.com/opt/page');
    expect(sanitizeBenchmarkText('file:///Users/alice/project/index.js:4')).toBe('file:///workspace/index.js:4');
  });

  it('strips terminal color codes before making machine paths relative', () => {
    const coloredPath =
      '\u001b[331m/\u001b[339mVolumes\u001b[49m\u001b[331m/\u001b[3103mExternalSSD\u001b[49m\u001b[331m/\u001b[3103mDeveloper\u001b[49m\u001b[331m/\u001b[3103mstim-bench\u001b[49m';

    expect(sanitizeBenchmarkText(coloredPath)).toBe('workspace/stim-bench');
  });

  it('redacts local hostnames and complete or abbreviated simulator identifiers', () => {
    expect(
      sanitizeBenchmarkText('Janics-Mac-mini.local A35AFE7E-06D9-4E4B-A14D-0451595A13BC grep A35AFE7E (3372..)'),
    ).toBe('<local-host> <simulator-udid> grep <simulator-udid-prefix> (<simulator-udid-prefix>)');
    expect(sanitizeBenchmarkText('estimated cost 0.02353276')).toBe('estimated cost 0.02353276');
    expect(sanitizeBenchmarkText('http%3A%2F%2F127.0.0.1%3A8081')).toBe('http%3A%2F%2F<local-ip>%3A8081');
  });

  it('omits machine-global process output', () => {
    const output = sanitizeCommandOutput(
      '/bin/zsh -lc "ps -axo command= | rg \'expo|metro\'"',
      'node ./node_modules/.bin/expo start\n/bin/zsh -c tail -F workspace/release-rc7/qa-progress.log',
    );

    expect(output).toBe('<process output omitted from public artifact>');
  });

  it('omits interactive shell transcripts with cursor-control fragments', () => {
    const output = sanitizeCommandOutput(
      'zsh',
      '\u001b[331m/\u001b[339mVolumes\r<external path rewritten by the terminal',
    );

    expect(output).toBe('<interactive shell transcript omitted from public artifact>');
  });

  it('omits machine-global device inventories', () => {
    const output = sanitizeCommandOutput(
      'xcrun simctl boot <simulator-udid>\nxcrun simctl list devices | grep benchmark',
      'Old iPhone (ios device target=mobile) booted=true\nJanics-Mac-mini.local booted=true',
    );

    expect(output).toBe('<device inventory omitted from public artifact>');
  });

  it('omits machine-global storage inventories', () => {
    expect(sanitizeCommandOutput('df -h /Volumes/ExternalSSD; diskutil info /Volumes/ExternalSSD', 'private')).toBe(
      '<machine storage inventory omitted from public artifact>',
    );
  });

  it('omits branch inventories that can contain user-scoped remote refs', () => {
    expect(
      sanitizeCommandOutput('git status --short; git branch -a', 'remotes/origin/@janic/issue-1-clear-filters'),
    ).toBe('<branch inventory omitted from public artifact>');
    expect(
      sanitizeCommandOutput('git worktree list && git status', 'worktree/private-diagnostic [private-branch]'),
    ).toBe('<branch inventory omitted from public artifact>');
  });

  it('omits coordinator listings and unrelated AVD names without changing ordinary command output', () => {
    for (const command of [
      'ls -la /private/benchmark; echo ---; ls -la /private/benchmark/state',
      'ls ~/.android/avd',
      'find /private/benchmark/results -maxdepth 2 -type d',
      '/bin/ls -la /private/benchmark',
    ]) {
      expect(sanitizeCommandOutput(command, 'private-run-id\nPersonal_Device.avd\nprivate-audit.json')).toBe(
        '<directory inventory omitted from public artifact>',
      );
    }
    expect(sanitizeCommandOutput('cat build.log', 'BUILD SUCCESSFUL')).toBe('BUILD SUCCESSFUL');
  });

  it('redacts a user-scoped remote branch outside an inventory', () => {
    expect(sanitizeBenchmarkText('checked remotes/origin/@private-user/feature')).toBe(
      'checked remotes/origin/@<user>/feature',
    );
  });

  it('redacts a helper identifier before replacing an OS username inside it', () => {
    const username = userInfo().username;
    const output = sanitizeBenchmarkText(`com.owner.agentdevice.${username}.uitests.xct${username}`);

    expect(output).toBe('<agent-device-helper>');
  });

  it('prices cached input separately without double-counting reasoning tokens', () => {
    const cost = estimateTokenCost(
      {
        input_tokens: 447_299,
        cached_input_tokens: 392_448,
        output_tokens: 3_928,
        reasoning_output_tokens: 1_171,
      },
      'gpt-5.6-luna',
    );

    expect(cost).toBeCloseTo(0.02353276, 8);
  });

  it('combines sanitized hardware with recorded toolchain and simulator facts', () => {
    const environment = benchmarkEnvironment(
      {
        preflight: {
          actual: {
            MACOS_VERSION: '26.5.2',
            MACOS_BUILD: '25F84',
            XCODE_VERSION: '26.6',
            XCODE_BUILD: '17F113',
            NODE_VERSION: '26.7.0',
          },
          parkedSimulator: {
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
          },
        },
      },
      { model: 'Mac mini', chip: 'Apple M4 Pro', memory: '64 GB' },
    );

    expect(environment).toEqual({
      machine: { model: 'Mac mini', chip: 'Apple M4 Pro', memory: '64 GB' },
      macos: 'macOS 26.5.2 (25F84)',
      xcode: 'Xcode 26.6 (17F113)',
      node: 'Node 26.7.0',
      simulator: 'iPhone 17 / iOS 26.5',
    });
  });

  it('reports the Android toolchain and exact system image', () => {
    const environment = benchmarkEnvironment(
      {
        platform: 'android',
        preflight: {
          actual: {
            MACOS_VERSION: '26.5.2',
            MACOS_BUILD: '25F84',
            ANDROID_SDK_VERSION: '20.0',
            ANDROID_EMULATOR_VERSION: '36.4.9.0 (build_id 14788078) (CL:N/A)',
            ADB_VERSION: '36.0.2-14143358',
            NODE_VERSION: '26.7.0',
          },
        },
        expectedStimDevice: {
          runtimeIdentifier: 'Android-36',
          systemImage: 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a',
        },
      },
      { model: 'Mac mini', chip: 'Apple M4 Pro', memory: '64 GB' },
    );

    expect(environment).toEqual({
      machine: { model: 'Mac mini', chip: 'Apple M4 Pro', memory: '64 GB' },
      macos: 'macOS 26.5.2 (25F84)',
      xcode: 'Android SDK 20.0 / Emulator 36.4.9 (build_id 14788078) (CL:N/A) / adb 36.0.2-14143358',
      node: 'Node 26.7.0',
      simulator: 'Android-36 / system-images;android-36;google_apis_playstore_ps16k;arm64-v8a',
    });
  });

  it('extracts Claude Bash commands, output, and text messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-claude-events-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        stamp('2026-09-03T20:00:01.000Z', {
          type: 'assistant',
          uuid: 'note-1',
          message: { content: [{ type: 'text', text: 'Checking the app.' }] },
        }),
        stamp('2026-09-03T20:00:02.000Z', {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'stim ios' } }],
          },
        }),
        stamp('2026-09-03T20:00:05.000Z', {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'build ok', is_error: false }] },
        }),
      ].join('\n'),
    );

    expect(eventsFor(dir, '2026-09-03T20:00:00.000Z', [])).toEqual({
      messages: [{ id: 'note-1-0', atSeconds: 1, text: 'Checking the app.' }],
      commands: [
        {
          id: 'tool-1',
          startSeconds: 2,
          endSeconds: 5,
          command: 'stim ios',
          output: 'build ok',
          exitCode: 0,
        },
      ],
    });
  });

  it('omits invalid attempts and their proof from a complete export', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-benchmark-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'test-rc1');
    const invalidRunDir = join(stageDir, 'private-invalid-run-id');
    const validRunDir = join(stageDir, 'private-valid-run-id');
    mkdirSync(join(invalidRunDir, 'proof'), { recursive: true });
    mkdirSync(join(validRunDir, 'proof'), { recursive: true });
    writeFileSync(
      join(invalidRunDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-03T20:00:00.000Z', finishedAt: '2026-09-03T20:00:01.000Z' }),
    );
    writeFileSync(
      join(invalidRunDir, 'run.json'),
      JSON.stringify({
        runId: 'private-invalid-run-id',
        model: 'gpt-5.6-sol',
        variant: 'fixture',
        arm: 'stim',
        valid: false,
        invalidReasons: ['missing command for A35AFE7E-06D9-4E4B-A14D-0451595A13BC (3372..) on Janics-Mac-mini.local'],
        commandCount: 0,
        screen: { valid: true },
      }),
    );
    writeFileSync(join(invalidRunDir, 'proof', 'settings.png'), 'invalid proof');
    writeFileSync(
      join(validRunDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-03T20:00:02.000Z', finishedAt: '2026-09-03T20:00:03.000Z' }),
    );
    writeFileSync(
      join(validRunDir, 'run.json'),
      JSON.stringify({
        runId: 'private-valid-run-id',
        model: 'gpt-5.6-sol',
        variant: 'fixture',
        arm: 'control',
        valid: true,
        invalidReasons: [],
        dispatchToScreenReadySeconds: 1,
        commandCount: 0,
        screen: { valid: true, expected: 'Offline maps', dimensions: { width: 402, height: 874 } },
        simulator: { udid: 'A35AFE7E-06D9-4E4B-A14D-0451595A13BC' },
      }),
    );
    writeFileSync(join(validRunDir, 'proof', 'settings.png'), 'valid proof');
    writeFileSync(
      join(validRunDir, 'events.jsonl'),
      stamp('2026-09-03T20:00:02.500Z', {
        type: 'item.completed',
        item: {
          id: 'logs',
          type: 'command_execution',
          command: 'cat app.log',
          aggregated_output:
            '/Users/alice/Library/Developer/CoreSimulator/Devices/A35AFE7E-06D9-4E4B-A14D-0451595A13BC/data/Containers/Data/Application/B35AFE7E-06D9-4E4B-A14D-0451595A13BC/Library/HTTPStorages/example.app ' +
            'worktree/project/B35AFE7E-06D9-4E4B-A14D-0451595A13BC/Library/data ' +
            '/System/Library/EventTimingProfiles/Sim.Touch.plist -L/Volumes/private/lib file:///Users/alice/private.log',
          exit_code: 0,
        },
      }),
    );

    const proofDir = join(root, 'proof');
    mkdirSync(proofDir, { recursive: true });
    writeFileSync(join(proofDir, 'native-stim-invalid-1.png'), 'stale invalid proof');
    const payload = exportBenchmark(stageDir, join(root, 'benchmark.json'), proofDir, {
      model: 'Test Mac',
      chip: 'Test chip',
      memory: 'Test memory',
    });

    expect(payload.runs.map((run) => run.id)).toEqual(['fixture-control']);
    expect(payload.recordedOn).toBe('2026-09-03');
    expect(payload.runs[0].commands[0].output).toBe(
      'workspace/example.app worktree/project/simulator-udid/Library/data ' +
        'system/System/Library/EventTimingProfiles/Sim.Touch.plist -Lworkspace/lib file:///workspace/private.log',
    );
    expect(readdirSync(proofDir)).toEqual(['fixture-control.png']);
  });

  it('requires integrity-bound Android evidence even when correcting a session audit', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-android-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'sol-android');
    const runDir = join(stageDir, 'private-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    const dispatchAt = '2026-09-04T12:00:00.000Z';
    const commandEvents = [
      ['open', 1, 2, 'agent-device open com.example.app', 'emulator emulator-5554'],
      ['record-start', 3, 4, 'agent-device record start proof/session.mp4', 'recording'],
      ['wait', 5, 6, 'agent-device wait text "Keep saved trail maps available offline"', 'found'],
      ['screenshot', 7, 8, 'agent-device screenshot /tmp/settings.png', 'saved'],
      ['copy', 9, 10, 'cp /tmp/settings.png proof/settings.png', ''],
      ['record-stop', 11, 12, 'agent-device record stop', 'saved'],
      ['close', 13, 14, 'agent-device close', ''],
    ];
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${commandEvents
        .flatMap(([id, start, end, command, output]) => [
          stamp(new Date(Date.parse(dispatchAt) + start * 1000).toISOString(), {
            type: 'item.started',
            item: { id, type: 'command_execution', command },
          }),
          stamp(new Date(Date.parse(dispatchAt) + end * 1000).toISOString(), {
            type: 'item.completed',
            item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: 0 },
          }),
        ])
        .join('\n')}\n`,
    );
    const proofPath = join(runDir, 'proof', 'settings.png');
    copyFileSync(join(process.cwd(), 'website/static/benchmarks/sol-launch-crash/launch-crash-stim.png'), proofPath);
    const bundlePath = join(runDir, 'proof', 'metro-8081-at-app-alive.bundle');
    writeFileSync(bundlePath, 'Keep saved trail maps available offline');
    const recordingPath = join(runDir, 'proof', 'session.mp4');
    copyFileSync(
      join(process.cwd(), 'website/static/benchmarks/luna-rc12/javascript-stim-interaction.mp4'),
      recordingPath,
    );
    const rolloutPath = join(runDir, 'rollout.jsonl');
    writeFileSync(rolloutPath, '{}\n');
    writeFileSync(join(runDir, 'avds-before.json'), '[]\n');
    writeFileSync(join(runDir, 'devices-before.json'), '[]\n');
    writeFileSync(
      join(runDir, 'app-alive.json'),
      JSON.stringify({ dispatchToAppAliveSeconds: 5, simulator: { udid: 'emulator-5554' } }),
    );
    writeFileSync(
      join(runDir, 'cleanup.json'),
      JSON.stringify({
        cleanedAt: '2026-09-04T12:01:00.000Z',
        actions: [
          'verified benchmark agent-device sessions empty',
          'delete AVD Trailhead_private-run-id',
          'remove worktree worktree/private-run-id',
        ],
      }),
    );
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({
        runId: 'private-run-id',
        runner: 'codex',
        model: 'gpt-5.6-sol',
        arm: 'control',
        variant: 'javascript',
        platform: 'android',
        dispatchAt,
        finishedAt: '2026-09-04T12:01:00.000Z',
        expectedControlSimulator: { name: 'Trailhead_private-run-id' },
      }),
    );
    const recordPath = join(runDir, 'run.json');
    const record = {
      runId: 'private-run-id',
      runner: 'codex',
      model: 'gpt-5.6-sol',
      variant: 'javascript',
      arm: 'control',
      valid: true,
      invalidReasons: [],
      dispatchToAppAliveSeconds: 5,
      dispatchToScreenReadySeconds: 8,
      simulator: { udid: 'emulator-5554' },
      commandCount: 7,
      proof: { valid: true, expected: 'Keep saved trail maps available offline', target: bundlePath },
      screen: {
        valid: true,
        expected: 'Keep saved trail maps available offline',
        dimensions: { width: 402, height: 874 },
        observedAt: '2026-09-04T12:00:08.000Z',
        dispatchToScreenReadySeconds: 8,
        openCommandId: 'open',
        recordStartCommandId: 'record-start',
        waitCommandId: 'wait',
        screenshotCommandId: 'screenshot',
        copyCommandId: 'copy',
        recordStopCommandId: 'record-stop',
        closeCommandId: 'close',
      },
      recording: {
        valid: true,
        target: recordingPath,
        bytes: readFileSync(recordingPath).length,
        startedAt: '2026-09-04T12:00:04.000Z',
        endedAt: '2026-09-04T12:00:12.000Z',
        startCommandId: 'record-start',
        stopCommandId: 'record-stop',
      },
      evidenceSha256: {
        events: sha256(join(runDir, 'events.jsonl')),
        settingsPng: sha256(proofPath),
        transcript: sha256(rolloutPath),
        proof: sha256(bundlePath),
        recording: sha256(recordingPath),
      },
    };
    writeFileSync(recordPath, JSON.stringify(record));

    const payload = exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'));
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0].commands[0].output).toBe('emulator <simulator-udid>');

    const eventsPath = join(runDir, 'events.jsonl');
    const metaPath = join(runDir, 'meta.json');
    const originalEvents = readFileSync(eventsPath, 'utf8');
    const originalMeta = readFileSync(metaPath, 'utf8');
    const prefix = 'env AGENT_DEVICE_STATE_DIR=state AGENT_DEVICE_SESSION=private-run-id agent-device ';
    const scopedEvents = originalEvents
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const stamped = JSON.parse(line);
        const event = JSON.parse(stamped.line);
        event.item.command = event.item.command.replace(/^agent-device /, prefix);
        stamped.line = JSON.stringify(event);
        return stamped;
      });
    writeFileSync(eventsPath, scopedEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
    writeFileSync(
      metaPath,
      JSON.stringify({ ...JSON.parse(originalMeta), agentDevice: { stateDir: 'state', session: 'private-run-id' } }),
    );
    const commandsPath = join(runDir, 'commands.log');
    const scopedCommands = scopedEvents
      .map((event) => JSON.parse(event.line))
      .filter((event) => event.type === 'item.started')
      .map(({ item }) => ({ id: item.id, command: item.command }));
    writeFileSync(commandsPath, scopedCommands.map((command) => JSON.stringify(command)).join('\n') + '\n');
    const rejectedRecord = {
      ...record,
      valid: false,
      invalidReasons: ['agent-device-run-session-not-applied'],
      evidenceSha256: { ...record.evidenceSha256, events: sha256(eventsPath) },
    };
    writeFileSync(recordPath, JSON.stringify(rejectedRecord));
    const correctionPath = join(runDir, 'lookup-audit-correction.json');
    const correction = {
      schemaVersion: 1,
      runId: record.runId,
      originalRecordSha256: sha256(recordPath),
      correctionSourceSha256: sha256(join(process.cwd(), 'scripts/agent-benchmark/run-guards.mjs')),
      commandsSha256: sha256(commandsPath),
      commandCount: scopedCommands.length,
    };
    writeFileSync(correctionPath, JSON.stringify(correction));
    expect(exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof')).runs[0]).toMatchObject({
      valid: true,
      settingsReadySeconds: 8,
    });
    expect(JSON.parse(readFileSync(recordPath))).toEqual(rejectedRecord);
    for (const change of [
      { originalRecordSha256: 'stale' },
      { commandsSha256: 'stale' },
      { correctionSourceSha256: 'stale' },
      { commandCount: 0 },
    ]) {
      writeFileSync(correctionPath, JSON.stringify({ ...correction, ...change }));
      expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
        'no valid benchmark runs found',
      );
    }
    const otherFailure = {
      ...rejectedRecord,
      invalidReasons: [...rejectedRecord.invalidReasons, 'benchmark-run-timeout'],
    };
    writeFileSync(recordPath, JSON.stringify(otherFailure));
    writeFileSync(correctionPath, JSON.stringify({ ...correction, originalRecordSha256: sha256(recordPath) }));
    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
      'no valid benchmark runs found',
    );
    writeFileSync(recordPath, JSON.stringify(rejectedRecord));
    writeFileSync(correctionPath, JSON.stringify(correction));
    writeFileSync(
      commandsPath,
      scopedCommands
        .map((command, index) =>
          JSON.stringify(index === 0 ? { ...command, command: 'agent-device snapshot' } : command),
        )
        .join('\n') + '\n',
    );
    writeFileSync(correctionPath, JSON.stringify({ ...correction, commandsSha256: sha256(commandsPath) }));
    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
      'no valid benchmark runs found',
    );
    writeFileSync(commandsPath, scopedCommands.map((command) => JSON.stringify(command)).join('\n') + '\n');
    writeFileSync(correctionPath, JSON.stringify(correction));
    writeFileSync(
      metaPath,
      JSON.stringify({
        ...JSON.parse(originalMeta),
        agentDevice: { stateDir: 'wrong-state', session: 'private-run-id' },
      }),
    );
    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
      'no valid benchmark runs found',
    );
    writeFileSync(metaPath, originalMeta);
    writeFileSync(eventsPath, originalEvents);
    writeFileSync(recordPath, JSON.stringify(record));

    const completeRecording = readFileSync(recordingPath);
    const shortRecording = Buffer.from(completeRecording);
    const movieHeader = shortRecording.indexOf(Buffer.from('mvhd'));
    const movieHeaderVersion = shortRecording[movieHeader + 4];
    const timescaleOffset = movieHeaderVersion === 1 ? movieHeader + 24 : movieHeader + 16;
    const durationOffset = movieHeaderVersion === 1 ? movieHeader + 28 : movieHeader + 20;
    const timescale = shortRecording.readUInt32BE(timescaleOffset);
    if (movieHeaderVersion === 1) shortRecording.writeBigUInt64BE(BigInt(timescale), durationOffset);
    else shortRecording.writeUInt32BE(timescale, durationOffset);
    writeFileSync(recordingPath, shortRecording);
    record.evidenceSha256.recording = sha256(recordingPath);
    writeFileSync(recordPath, JSON.stringify(record));
    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
      'no valid benchmark runs found',
    );
    writeFileSync(recordingPath, completeRecording);
    record.evidenceSha256.recording = sha256(recordingPath);
    writeFileSync(recordPath, JSON.stringify(record));

    for (const mutate of [
      () => writeFileSync(bundlePath, 'tampered'),
      () => writeFileSync(join(runDir, 'avds-before.json'), JSON.stringify(['Trailhead_private-run-id'])),
      () => writeFileSync(join(runDir, 'cleanup.json'), JSON.stringify({ cleanedAt: 'now', actions: [] })),
    ]) {
      mutate();
      expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
        'no valid benchmark runs found',
      );
      writeFileSync(bundlePath, 'Keep saved trail maps available offline');
      writeFileSync(join(runDir, 'avds-before.json'), '[]\n');
      writeFileSync(
        join(runDir, 'cleanup.json'),
        JSON.stringify({
          cleanedAt: '2026-09-04T12:01:00.000Z',
          actions: [
            'verified benchmark agent-device sessions empty',
            'delete AVD Trailhead_private-run-id',
            'remove worktree worktree/private-run-id',
          ],
        }),
      );
    }
  });

  it('requires isolated iOS readiness commands, recording copy, and owned cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-ios-export-'));
    tempDirs.push(root);
    const runId = 'private-ios-run-id';
    const stageDir = join(root, 'results', 'sol-ios');
    const runDir = join(stageDir, runId);
    const proofDir = join(runDir, 'proof');
    mkdirSync(proofDir, { recursive: true });
    const dispatchAt = '2026-09-04T12:00:00.000Z';
    const stateDir = join(root, 'state', 'agent-device');
    const udid = 'A35AFE7E-06D9-4E4B-A14D-0451595A13BC';
    const prefix = `env AGENT_DEVICE_STATE_DIR=${stateDir} AGENT_DEVICE_SESSION=${runId} agent-device`;
    const screenshotScratch = join('/tmp', `${runId}-settings.png`);
    const recordingScratch = join('/tmp', `${runId}-session.mp4`);
    const proofPath = join(proofDir, 'settings.png');
    const recordingPath = join(proofDir, 'session.mp4');
    const bundlePath = join(proofDir, 'metro-8081-at-app-alive.bundle');
    const commandEvents = [
      [
        'open',
        1,
        2,
        `${prefix} open com.appandflow.trailhead --foreground --platform ios --udid ${udid}`,
        `Opened: com.appandflow.trailhead\nSession state: ${stateDir}/sessions/${runId}\n`,
      ],
      [
        'record-start',
        3,
        4,
        `${prefix} record start ${recordingScratch} --scope device --quality high --hide-touches`,
        `${recordingScratch}\n`,
      ],
      ['wait', 5, 6, `${prefix} wait text "Keep saved trail maps available offline"`, ''],
      ['screenshot', 7, 8, `${prefix} screenshot ${screenshotScratch}`, `${screenshotScratch} (402x874 @1x)\n`],
      ['copy', 9, 10, `cp ${screenshotScratch} ${proofPath}`, ''],
      ['record-stop', 11, 12, `${prefix} record stop`, `${recordingScratch}\n`],
      ['record-copy', 13, 14, `cp ${recordingScratch} ${recordingPath}`, ''],
      ['close', 15, 16, `${prefix} close`, `Closed: ${runId}\n`],
    ];
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${commandEvents
        .flatMap(([id, start, end, command, output]) => [
          stamp(new Date(Date.parse(dispatchAt) + start * 1000).toISOString(), {
            type: 'item.started',
            item: { id, type: 'command_execution', command },
          }),
          stamp(new Date(Date.parse(dispatchAt) + end * 1000).toISOString(), {
            type: 'item.completed',
            item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: 0 },
          }),
        ])
        .join('\n')}\n`,
    );
    copyFileSync(join(process.cwd(), 'website/static/benchmarks/sol-launch-crash/launch-crash-stim.png'), proofPath);
    copyFileSync(
      join(process.cwd(), 'website/static/benchmarks/luna-rc12/javascript-stim-interaction.mp4'),
      recordingPath,
    );
    writeFileSync(bundlePath, 'Keep saved trail maps available offline');
    writeFileSync(join(runDir, 'rollout.jsonl'), '{}\n');
    writeFileSync(join(runDir, 'devices-before.json'), `${JSON.stringify([udid])}\n`);
    writeFileSync(
      join(runDir, 'app-alive.json'),
      JSON.stringify({ dispatchToAppAliveSeconds: 5, simulator: { udid } }),
    );
    writeFileSync(
      join(runDir, 'cleanup.json'),
      JSON.stringify({
        cleanedAt: '2026-09-04T12:01:00.000Z',
        actions: [
          'verified benchmark agent-device sessions empty',
          'stim worktree remove --force',
          `verified parked simulator ${udid}`,
          `verified quiescent simulator ${udid}`,
        ],
      }),
    );
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({
        runId,
        runner: 'codex',
        model: 'gpt-5.6-sol',
        arm: 'stim',
        variant: 'javascript',
        platform: 'ios',
        dispatchAt,
        finishedAt: '2026-09-04T12:01:00.000Z',
        agentDevice: { stateDir, session: runId },
        expectedParkedSimulator: { udid },
      }),
    );
    const eventsPath = join(runDir, 'events.jsonl');
    const recordPath = join(runDir, 'run.json');
    const record = {
      runId,
      runner: 'codex',
      model: 'gpt-5.6-sol',
      variant: 'javascript',
      arm: 'stim',
      valid: true,
      invalidReasons: [],
      dispatchToAppAliveSeconds: 5,
      dispatchToScreenReadySeconds: 8,
      simulator: { udid },
      commandCount: 8,
      proof: { valid: true, expected: 'Keep saved trail maps available offline', target: bundlePath },
      screen: {
        valid: true,
        expected: 'Keep saved trail maps available offline',
        dimensions: { width: 402, height: 874 },
        observedAt: '2026-09-04T12:00:08.000Z',
        dispatchToScreenReadySeconds: 8,
        openCommandId: 'open',
        recordStartCommandId: 'record-start',
        waitCommandId: 'wait',
        screenshotCommandId: 'screenshot',
        copyCommandId: 'copy',
        recordStopCommandId: 'record-stop',
        recordingCopyCommandId: 'record-copy',
        closeCommandId: 'close',
        commands: commandEvents.map((event) => event[3]),
      },
      recording: {
        valid: true,
        target: recordingPath,
        bytes: readFileSync(recordingPath).length,
        startedAt: '2026-09-04T12:00:04.000Z',
        endedAt: '2026-09-04T12:00:12.000Z',
        startCommandId: 'record-start',
        stopCommandId: 'record-stop',
        copyCommandId: 'record-copy',
      },
      evidenceSha256: {
        events: sha256(eventsPath),
        settingsPng: sha256(proofPath),
        transcript: sha256(join(runDir, 'rollout.jsonl')),
        proof: sha256(bundlePath),
        recording: sha256(recordingPath),
      },
    };
    writeFileSync(recordPath, JSON.stringify(record));

    expect(exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof')).runs).toHaveLength(1);
    delete record.screen.recordingCopyCommandId;
    writeFileSync(recordPath, JSON.stringify(record));
    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'public-proof'))).toThrow(
      'no valid benchmark runs found',
    );
  });

  it('refuses to publish a block with no valid attempts', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-benchmark-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'test-rc1');
    const runDir = join(stageDir, 'private-invalid-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-03T20:00:00.000Z', finishedAt: '2026-09-03T20:00:01.000Z' }),
    );
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'private-invalid-run-id',
        model: 'gpt-5.6-sol',
        variant: 'native',
        arm: 'stim',
        valid: false,
        commandCount: 0,
        screen: { valid: false },
      }),
    );

    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'))).toThrow(
      'no valid benchmark runs found',
    );
  });

  it('exports launch-crash diagnosis metrics as a separate suite', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-launch-crash-export-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'sol-launch-crash');
    const runDir = join(stageDir, 'private-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({
        dispatchAt: '2026-09-04T12:00:00.000Z',
        finishedAt: '2026-09-04T12:03:00.000Z',
        platform: 'ios',
      }),
    );
    const token = 'STIM_BENCH_LAUNCH_CRASH_ABCDEF123456';
    const commandEvents = [
      [
        'skill',
        '2026-09-04T12:00:01.000Z',
        '2026-09-04T12:00:02.000Z',
        'sed -n 1,200p /bench/skills/stim/SKILL.md',
        'skill',
      ],
      ['worktree', '2026-09-04T12:00:03.000Z', '2026-09-04T12:00:05.000Z', 'stim worktree create bench/run', 'ready'],
      [
        'metadata',
        '2026-09-04T12:00:06.000Z',
        '2026-09-04T12:00:07.000Z',
        String.raw`/bin/zsh -lc "node -p \"require.resolve('expo/package.json')\" && node_modules/.bin/expo --version"`,
        '58.0.0-canary',
      ],
      ['launch', '2026-09-04T12:00:10.000Z', '2026-09-04T12:00:20.000Z', 'stim ios', 'app launched'],
      ['logs', '2026-09-04T12:00:25.000Z', '2026-09-04T12:00:30.000Z', 'stim logs --errors', token],
      [
        'diagnosis',
        '2026-09-04T12:01:29.000Z',
        '2026-09-04T12:01:30.000Z',
        `rg ${token} app/_layout.tsx`,
        `${token}\napp/_layout.tsx:28 in RootLayout`,
      ],
      [
        'reload',
        '2026-09-04T12:01:40.000Z',
        '2026-09-04T12:02:00.000Z',
        'agent-device metro reload --metro-port 8082',
        'Reload broadcast sent',
      ],
      [
        'screenshot',
        '2026-09-04T12:02:29.000Z',
        '2026-09-04T12:02:30.000Z',
        'agent-device screenshot /tmp/settings.png',
        'saved',
      ],
    ];
    writeFileSync(
      join(runDir, 'events.jsonl'),
      `${commandEvents
        .flatMap(([id, startedAt, endedAt, command, output]) => [
          stamp(startedAt, { type: 'item.started', item: { id, type: 'command_execution', command } }),
          stamp(endedAt, {
            type: 'item.completed',
            item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: 0 },
          }),
        ])
        .join('\n')}\n`,
    );
    const proofPath = join(runDir, 'proof', 'settings.png');
    copyFileSync(join(process.cwd(), 'website/static/benchmarks/sol-launch-crash/launch-crash-stim.png'), proofPath);
    const rolloutPath = join(runDir, 'rollout.jsonl');
    writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: '2026-09-04T12:01:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100_000,
              cached_input_tokens: 80_000,
              output_tokens: 1_000,
              reasoning_output_tokens: 100,
            },
          },
        },
      })}\n`,
    );
    const recordPath = join(runDir, 'run.json');
    writeFileSync(
      recordPath,
      JSON.stringify({
        runId: 'private-run-id',
        runner: 'codex',
        model: 'gpt-5.6-sol',
        variant: 'launch-crash',
        arm: 'stim',
        valid: true,
        invalidReasons: [],
        dispatchToDiagnosisSeconds: 90,
        diagnosisCommandCount: 6,
        diagnosisUsage: {
          input_tokens: 100_000,
          cached_input_tokens: 80_000,
          output_tokens: 1_000,
          reasoning_output_tokens: 100,
        },
        diagnosis: {
          valid: true,
          observedAt: '2026-09-04T12:01:30.000Z',
          commandId: 'diagnosis',
          initialLaunchCommandId: 'launch',
          errorCaptureCommandId: 'logs',
        },
        dispatchToScreenReadySeconds: 150,
        commandCount: 10,
        usage: {
          input_tokens: 200_000,
          cached_input_tokens: 160_000,
          output_tokens: 2_000,
          reasoning_output_tokens: 200,
        },
        proof: { valid: true, expected: `${token} removed and original source restored` },
        recovery: { valid: true, screenshotCommandId: 'screenshot' },
        screen: {
          valid: true,
          expected: 'Keep map tiles for saved trails on device',
          dimensions: { width: 402, height: 874 },
          observedAt: '2026-09-04T12:02:30.000Z',
          dispatchToScreenReadySeconds: 150,
          screenshotCommandId: 'screenshot',
        },
        evidenceSha256: {
          events: sha256(join(runDir, 'events.jsonl')),
          settingsPng: sha256(proofPath),
          transcript: sha256(rolloutPath),
        },
      }),
    );

    const payload = exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'));

    expect(payload).toMatchObject({
      suite: 'launch-crash',
      platform: 'ios',
      primaryMetric: 'Dispatch to first actionable diagnosis; repaired Settings screenshot reported separately',
    });
    expect(payload.runs[0]).toMatchObject({
      id: 'launch-crash-stim',
      platform: 'ios',
      diagnosisSeconds: 90,
      diagnosisCommandCount: 6,
      launchCrashAudit: {
        initialLaunchCommandId: 'launch',
        errorCaptureCommandId: 'logs',
        diagnosisCommandId: 'diagnosis',
        screenshotCommandId: 'screenshot',
      },
      estimatedDiagnosisCostUsd: 0.132,
    });
    expect(payload.runs[0].markers).toContainEqual({
      id: 'diagnosis',
      kind: 'diagnosis',
      label: 'Actionable diagnosis',
      atSeconds: 90,
    });

    const original = JSON.parse(readFileSync(recordPath, 'utf8'));
    const eventsPath = join(runDir, 'events.jsonl');
    const originalEvents = readFileSync(eventsPath, 'utf8');
    const unfamiliar = `/bin/zsh -lc "printf 'SETUP_COMPLETE\\n'"`;
    const reviewedEvents =
      originalEvents
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const stamped = JSON.parse(line);
          const event = JSON.parse(stamped.line);
          if (event.item.id === 'metadata') event.item.command = unfamiliar;
          return JSON.stringify({ ...stamped, line: JSON.stringify(event) });
        })
        .join('\n') + '\n';
    writeFileSync(eventsPath, reviewedEvents);
    const rejected = {
      ...original,
      valid: false,
      invalidReasons: [
        'launch-crash-pre-capture-command-not-allowed',
        'launch-crash-diagnosis-missing',
        'launch-crash-diagnosis-usage-missing',
      ],
      diagnosis: { valid: false, reason: 'launch-crash-pre-capture-command-not-allowed' },
      recovery: { valid: false, reason: 'launch-crash-diagnosis-missing' },
      dispatchToDiagnosisSeconds: null,
      diagnosisUsage: null,
      diagnosisCommandCount: null,
      evidenceSha256: { ...original.evidenceSha256, events: sha256(eventsPath) },
    };
    writeFileSync(recordPath, JSON.stringify(rejected));
    const reviewedExport = () => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'));
    expect(reviewedExport).toThrow('no valid benchmark runs found');
    writeFileSync(recordPath, JSON.stringify({ ...original, evidenceSha256: rejected.evidenceSha256 }));
    expect(reviewedExport).toThrow('no valid benchmark runs found');
    writeFileSync(recordPath, JSON.stringify(rejected));
    const reviewPath = join(runDir, 'launch-error-audit-review.json');
    const review = {
      schemaVersion: 1,
      runId: rejected.runId,
      originalRecordSha256: sha256(recordPath),
      metaSha256: sha256(join(runDir, 'meta.json')),
      policySha256: sha256(join(process.cwd(), 'scripts/launch-crash-benchmark.mjs')),
      shellParserSha256: sha256(join(process.cwd(), 'scripts/agent-benchmark/run-guards.mjs')),
      commands: [
        {
          commandId: 'metadata',
          command: unfamiliar,
          assessment: 'Prints a literal setup-complete message; no source access.',
        },
      ],
    };
    writeFileSync(reviewPath, JSON.stringify(review));
    expect(reviewedExport().runs[0]).toMatchObject({ valid: true, diagnosisSeconds: 90, settingsReadySeconds: 150 });
    expect(JSON.parse(readFileSync(recordPath))).toEqual(rejected);
    const launchRejected = {
      ...rejected,
      invalidReasons: ['launch-crash-initial-launch-evidence-missing', 'launch-crash-diagnosis-missing'],
    };
    writeFileSync(recordPath, JSON.stringify(launchRejected));
    writeFileSync(reviewPath, JSON.stringify({ ...review, originalRecordSha256: sha256(recordPath) }));
    expect(reviewedExport().runs[0]).toMatchObject({ valid: true, diagnosisSeconds: 90, settingsReadySeconds: 150 });
    expect(JSON.parse(readFileSync(recordPath))).toEqual(launchRejected);
    const missingLaunch = reviewedEvents.replaceAll('stim ios', 'echo no-launch');
    writeFileSync(eventsPath, missingLaunch);
    writeFileSync(
      recordPath,
      JSON.stringify({ ...launchRejected, evidenceSha256: { ...rejected.evidenceSha256, events: sha256(eventsPath) } }),
    );
    writeFileSync(reviewPath, JSON.stringify({ ...review, originalRecordSha256: sha256(recordPath) }));
    expect(reviewedExport).toThrow('no valid benchmark runs found');
    writeFileSync(eventsPath, reviewedEvents);
    writeFileSync(recordPath, JSON.stringify(rejected));
    for (const changed of [
      { originalRecordSha256: 'changed' },
      { metaSha256: 'changed' },
      { policySha256: 'changed' },
      { shellParserSha256: 'changed' },
      { commands: [] },
      { commands: [{ ...review.commands[0], command: 'different' }] },
      { commands: [{ ...review.commands[0], assessment: '' }] },
    ]) {
      writeFileSync(reviewPath, JSON.stringify({ ...review, ...changed }));
      expect(reviewedExport).toThrow('no valid benchmark runs found');
    }
    writeFileSync(
      recordPath,
      JSON.stringify({ ...rejected, invalidReasons: [...rejected.invalidReasons, 'control-emulator-mismatch'] }),
    );
    writeFileSync(reviewPath, JSON.stringify({ ...review, originalRecordSha256: sha256(recordPath) }));
    expect(reviewedExport).toThrow('no valid benchmark runs found');
    writeFileSync(recordPath, JSON.stringify(rejected));
    writeFileSync(reviewPath, JSON.stringify(review));
    writeFileSync(eventsPath, reviewedEvents.replaceAll('SETUP_COMPLETE', 'app/_layout.tsx'));
    expect(reviewedExport).toThrow('no valid benchmark runs found');
    writeFileSync(eventsPath, originalEvents);
    rmSync(reviewPath);
    for (const mutate of [
      (record) => (record.dispatchToDiagnosisSeconds = 1),
      (record) => (record.diagnosisCommandCount = 1),
      (record) => (record.dispatchToScreenReadySeconds = 1),
      (record) => (record.diagnosisUsage.input_tokens = 1),
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      writeFileSync(recordPath, JSON.stringify(changed));
      expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'))).toThrow(
        'no valid benchmark runs found',
      );
    }
    writeFileSync(recordPath, JSON.stringify(original));
    const prefix = 'env AGENT_DEVICE_STATE_DIR=/tmp/bench-state AGENT_DEVICE_SESSION=private-run-id agent-device ';
    const auxiliaryPrefix = prefix.replace('SESSION=private-run-id ', 'SESSION=private-run-id-diag ');
    const open = 'open com.appandflow.trailhead --foreground --platform ios --udid U1';
    const extraEvents = [
      ['aux-open', 100, `${auxiliaryPrefix}${open}`],
      ['aux-close', 110, `${auxiliaryPrefix}close`],
      ['proof-open', 140, `${prefix}${open}`],
    ].flatMap(([id, seconds, command]) => [
      stamp(new Date(Date.parse('2026-09-04T12:00:00Z') + seconds * 1000).toISOString(), {
        type: 'item.started',
        item: { id, type: 'command_execution', command },
      }),
      stamp(new Date(Date.parse('2026-09-04T12:00:00Z') + (seconds + 1) * 1000).toISOString(), {
        type: 'item.completed',
        item: { id, type: 'command_execution', command, aggregated_output: 'ok', exit_code: 0 },
      }),
    ]);
    const scopedEvents =
      originalEvents
        .trim()
        .split('\n')
        .map((line) => {
          const stamped = JSON.parse(line);
          const event = JSON.parse(stamped.line);
          if (event.item.command.startsWith('agent-device '))
            event.item.command = prefix + event.item.command.slice('agent-device '.length);
          return JSON.stringify({ ...stamped, line: JSON.stringify(event) });
        })
        .concat(extraEvents)
        .toSorted((a, b) => JSON.parse(a).arrivedAt.localeCompare(JSON.parse(b).arrivedAt))
        .join('\n') + '\n';
    writeFileSync(eventsPath, scopedEvents);
    const raw = join(runDir, 'raw');
    mkdirSync(raw);
    const source = 'export default function RootLayout() { return null; }\n';
    const lock = `PODS:\n  - Core (1.0)\n\nSPEC CHECKSUMS:\n  Core: ${'a'.repeat(40)}\n\nCOCOAPODS: 1.16.2\n`;
    writeFileSync(join(raw, 'Podfile.lock.base'), lock);
    writeFileSync(join(raw, 'Podfile.lock.final'), lock.replace('a'.repeat(40), 'b'.repeat(40)));
    writeFileSync(join(raw, 'launch-crash-source-final.tsx'), source);
    const metaPath = join(runDir, 'meta.json');
    const scopedMeta = {
      ...JSON.parse(readFileSync(metaPath)),
      runId: original.runId,
      agentDevice: { stateDir: '/tmp/bench-state', session: original.runId },
      crash: { sourceRelative: 'app/_layout.tsx', originalSha256: sha256(join(raw, 'launch-crash-source-final.tsx')) },
    };
    writeFileSync(metaPath, JSON.stringify(scopedMeta));
    const changedPaths = ['app/_layout.tsx', 'ios/Podfile.lock'];
    const auxiliaryRecord = {
      ...original,
      valid: false,
      invalidReasons: ['launch-crash-unrelated-source-changes', 'agent-device-run-session-not-applied'],
      simulator: { udid: 'U1' },
      proof: { ...original.proof, valid: false, changedPaths },
      evidenceSha256: { ...original.evidenceSha256, events: sha256(eventsPath) },
    };
    writeFileSync(recordPath, JSON.stringify(auxiliaryRecord));
    const evidencePath = join(raw, 'auxiliary-audit-evidence.json');
    const refreshEvidence = () =>
      writeFileSync(
        evidencePath,
        JSON.stringify({
          schemaVersion: 1,
          runId: original.runId,
          metaSha256: sha256(metaPath),
          changedPaths,
          files: Object.fromEntries(
            ['Podfile.lock.base', 'Podfile.lock.final', 'launch-crash-source-final.tsx'].map((name) => [
              name,
              sha256(join(raw, name)),
            ]),
          ),
        }),
      );
    refreshEvidence();
    const auxiliaryReview = {
      ...review,
      commands: [],
      originalRecordSha256: sha256(recordPath),
      metaSha256: sha256(metaPath),
      sourceChanges: {
        evidenceSha256: sha256(evidencePath),
        assessment: 'Only a spec checksum changed; source bytes match the original.',
      },
      auxiliarySessions: [{ session: 'private-run-id-diag', assessment: 'Same device, closed before proof.' }],
    };
    writeFileSync(reviewPath, JSON.stringify(auxiliaryReview));
    expect(reviewedExport().runs[0]).toMatchObject({ valid: true, diagnosisSeconds: 90, settingsReadySeconds: 150 });
    expect(JSON.parse(readFileSync(recordPath))).toEqual(auxiliaryRecord);
    for (const change of [
      { sourceChanges: undefined },
      { auxiliarySessions: [] },
      { sourceChanges: { ...auxiliaryReview.sourceChanges, evidenceSha256: 'changed' } },
      { auxiliarySessions: [{ session: 'private-run-id-diag', assessment: '' }] },
    ]) {
      writeFileSync(reviewPath, JSON.stringify({ ...auxiliaryReview, ...change }));
      expect(reviewedExport).toThrow('no valid benchmark runs found');
    }
    writeFileSync(join(raw, 'Podfile.lock.final'), lock.replace('(1.0)', '(2.0)'));
    refreshEvidence();
    writeFileSync(
      reviewPath,
      JSON.stringify({
        ...auxiliaryReview,
        sourceChanges: { ...auxiliaryReview.sourceChanges, evidenceSha256: sha256(evidencePath) },
      }),
    );
    expect(reviewedExport).toThrow('no valid benchmark runs found');
  });

  it('refuses a launch-crash record without audited recovery proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-launch-crash-invalid-'));
    tempDirs.push(root);
    const stageDir = join(root, 'results', 'sol-launch-crash');
    const runDir = join(stageDir, 'private-run-id');
    mkdirSync(join(runDir, 'proof'), { recursive: true });
    writeFileSync(
      join(runDir, 'meta.json'),
      JSON.stringify({ dispatchAt: '2026-09-04T12:00:00.000Z', finishedAt: '2026-09-04T12:03:00.000Z' }),
    );
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'private-run-id',
        model: 'gpt-5.6-sol',
        variant: 'launch-crash',
        arm: 'stim',
        valid: true,
        dispatchToDiagnosisSeconds: 90,
        diagnosisCommandCount: 5,
        diagnosis: { valid: true },
        proof: { valid: true },
        screen: { valid: true },
      }),
    );
    writeFileSync(join(runDir, 'proof', 'settings.png'), 'unverified proof');

    expect(() => exportBenchmark(stageDir, join(root, 'benchmark.json'), join(root, 'proof'))).toThrow(
      'no valid benchmark runs found',
    );
  });
});
