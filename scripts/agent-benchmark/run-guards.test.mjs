import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  agentDeviceIsolationInvalidReasons,
  agentDeviceAuxiliarySessions,
  benchmarkSetupInvalidReasons,
  benchmarkTarget,
  benchmarkTiming,
  parseBenchmarkTargets,
  shellCommandSegments,
  topLevelShellCommand,
  stimShellProvenanceInvalidReasons,
  benchmarkCcache,
  assertAndroidDoctorClean,
  runnerToolOutput,
  ccacheMeasurements,
} from './run-guards.mjs';

const targetConfig = parseBenchmarkTargets({
  schemaVersion: 1,
  machine: 'Test Mac',
  targets: {
    'android.native.stim': {
      screenReadySeconds: 300,
      platformCommandSeconds: 180,
      runTimeoutSeconds: 600,
    },
  },
});

const build = (output) => [{ id: 'build', command: 'stim android', exitCode: 0, output }];
const refusal = (output, exitCode = 1) => [{ id: 'refusal', command: 'stim android', exitCode, output }];

describe('agent-device session isolation', () => {
  const prefix = 'env AGENT_DEVICE_STATE_DIR=/tmp/bench-state AGENT_DEVICE_SESSION=bench-run agent-device ';

  it('recognizes scoped loop bodies without allowing an unscoped iteration command', () => {
    const scoped = `for i in 1 2 3; do ${prefix}press 'text="Open"' --settle 2>&1 | tail -4; done`;
    expect(agentDeviceIsolationInvalidReasons([{ command: scoped }], prefix)).toEqual([]);
    for (const command of [
      scoped.replace('SESSION=bench-run', 'SESSION=default'),
      scoped.replace('; done', '; agent-device close; done'),
    ]) {
      expect(agentDeviceIsolationInvalidReasons([{ command }], prefix)).toContain(
        'agent-device-run-session-not-applied',
      );
    }
  });

  it('allows help output without letting help hide an unscoped device command', () => {
    expect(
      agentDeviceIsolationInvalidReasons(
        [{ command: 'which agent-device; agent-device --help 2>&1 | head -20\nagent-device help open' }],
        prefix,
      ),
    ).toEqual([]);
    for (const command of [
      'agent-device help; agent-device snapshot',
      'agent-device help $(agent-device snapshot)',
      'agent-device --help `agent-device snapshot`',
    ]) {
      expect(agentDeviceIsolationInvalidReasons([{ command }], prefix)).toContain(
        'agent-device-run-session-not-applied',
      );
    }
  });

  it('requires auxiliary diagnosis to open the same device and close before pinned proof', () => {
    const auxiliary = prefix.replace('SESSION=bench-run ', 'SESSION=bench-run-diag ');
    const commands = [
      {
        id: 'diag-open',
        command: `${auxiliary}open com.appandflow.trailhead --foreground --platform ios --udid U1`,
        exitCode: 0,
      },
      { id: 'diag-click', command: `${auxiliary}click @e3 --settle`, exitCode: 0 },
      { id: 'diag-close', command: `${auxiliary}close`, exitCode: 0 },
      {
        id: 'proof',
        command: `${prefix}open com.appandflow.trailhead --foreground --platform ios --udid U1`,
        exitCode: 0,
      },
    ].map((entry, index) => Object.assign(entry, { startEventOffset: index * 2, endEventOffset: index * 2 + 1 }));
    const target = { platform: 'ios', device: 'U1' };
    expect(agentDeviceIsolationInvalidReasons(commands, prefix, target)).toEqual([]);
    expect(agentDeviceAuxiliarySessions(commands, prefix, target)).toEqual([
      {
        session: 'bench-run-diag',
        commands: commands.slice(0, 3).map(({ id, command }) => ({ commandId: id, command })),
      },
    ]);
    for (const changed of [
      commands.map((entry) => ({
        ...entry,
        command: entry.command.replace('SESSION=bench-run-diag ', 'SESSION=default '),
      })),
      commands.map((entry) => ({
        ...entry,
        command: entry.command.replace('STATE_DIR=/tmp/bench-state ', 'STATE_DIR=/tmp/other '),
      })),
      [{ ...commands[0], command: commands[0].command.replace('--udid U1', '--udid U2') }, ...commands.slice(1)],
      [...commands.slice(0, 2), commands[3]],
      [
        commands[0],
        commands[1],
        { ...commands[3], startEventOffset: 4, endEventOffset: 5 },
        { ...commands[2], startEventOffset: 6, endEventOffset: 7 },
      ],
      [commands[0], commands[1], { ...commands[2], exitCode: 1 }, commands[3]],
      [commands[0], { ...commands[1], command: `${auxiliary}click @e3 --session default` }, ...commands.slice(2)],
      [commands[0], { ...commands[1], command: `${auxiliary}snapshot '--session' default` }, ...commands.slice(2)],
      [commands[0], { ...commands[1], command: `${auxiliary}snapshot --se'ssion' default` }, ...commands.slice(2)],
      [commands[0], { ...commands[1], command: `${auxiliary}snapshot --ses\\sion default` }, ...commands.slice(2)],
      [...commands.slice(0, 3), { ...commands[3], startEventOffset: commands[2].startEventOffset }],
      [
        ...commands.slice(0, 2),
        { ...commands[3], command: `sleep 1; ${commands[3].command}`, startEventOffset: 3, endEventOffset: 4 },
        ...commands.slice(2),
      ],
      [commands[0], commands[1], { ...commands[2], parallelTimingAmbiguous: true }, commands[3]],
      [commands[0], { ...commands[1], command: `${auxiliary}click $(agent-device snapshot)` }, ...commands.slice(2)],
    ])
      expect(agentDeviceIsolationInvalidReasons(changed, prefix, target)).toContain(
        'agent-device-run-session-not-applied',
      );
    expect(
      agentDeviceIsolationInvalidReasons(
        [commands[0], { ...commands[1], command: `${auxiliary}fill @e3 "hello there"` }, ...commands.slice(2)],
        prefix,
        target,
      ),
    ).toEqual([]);
  });

  it('accepts delayed scoped navigation without splitting quoted separators', () => {
    for (const command of [
      `sleep 5; ${prefix}snapshot`,
      `/bin/zsh -lc 'sleep 5 && ${prefix}snapshot'`,
      `${prefix}fill @e5 "text; more text"`,
      `${prefix}snapshot\n${prefix}click @e1`,
    ]) {
      expect(agentDeviceIsolationInvalidReasons([{ command }], prefix)).toEqual([]);
    }
  });

  it('rejects an unscoped or mismatched invocation anywhere in a chain', () => {
    for (const command of [
      'agent-device snapshot',
      `sleep 5; agent-device snapshot`,
      `${prefix}snapshot; agent-device click @e1`,
      `${prefix}snapshot && ${prefix.replace('SESSION=bench-run', 'SESSION=default')}snapshot`,
      `agent-device snapshot\n${prefix}snapshot`,
    ]) {
      expect(agentDeviceIsolationInvalidReasons([{ command }], prefix)).toEqual([
        'agent-device-run-session-not-applied',
      ]);
    }
  });

  it('does not treat literal executable discovery as a device invocation', () => {
    for (const command of [
      'command -v agent-device',
      'command -V agent-device 2>&1',
      'which node agent-device adb',
      'type agent-device 2>/dev/null',
      'whence agent-device',
      'command -v agent-device daemon stop',
      'command -v agent-device &>/dev/null',
      `command -v agent-device 2>&1; ${prefix}snapshot`,
      `/bin/zsh -lc 'command -v agent-device 2>&1'`,
    ]) {
      expect(agentDeviceIsolationInvalidReasons([{ command }], prefix)).toEqual([]);
    }
  });

  it('does not let executable discovery hide an actual unscoped invocation', () => {
    for (const command of [
      'command agent-device snapshot',
      'command -p agent-device snapshot',
      'command -v agent-device; agent-device snapshot',
      'which agent-device && agent-device snapshot',
      'command -v agent-device $(agent-device snapshot)',
      'command -v agent-device >$(agent-device snapshot)',
      'command -v agent-device 2>&$(agent-device snapshot)',
      'command -v agent-device 2>&$(agent-device daemon stop)',
      'command -v agent-device; $(agent-device snapshot)',
      'command -v agent-device && $(agent-device daemon stop)',
      'command -v agent-device & `agent-device snapshot`',
      'type agent-device `agent-device snapshot`',
    ]) {
      expect(agentDeviceIsolationInvalidReasons([{ command }], prefix)).toContain(
        'agent-device-run-session-not-applied',
      );
    }
  });

  it('rejects delayed daemon recovery even with the correct session', () => {
    expect(agentDeviceIsolationInvalidReasons([{ command: `sleep 5; ${prefix}daemon stop --clean` }], prefix)).toEqual([
      'agent-device-daemon-recovery-inside-timer',
    ]);
    expect(
      agentDeviceIsolationInvalidReasons(
        [{ command: 'command -v agent-device && $(agent-device daemon stop)' }],
        prefix,
      ),
    ).toEqual(['agent-device-daemon-recovery-inside-timer', 'agent-device-run-session-not-applied']);
  });
});

describe('compiler cache health', () => {
  const meta = { arm: 'stim', platform: 'android', variant: 'native', timingTarget: { ccacheMinHitRatePercent: 50 } };

  it('flags the observed 9-hit 308-miss run and retains the measured evidence', () => {
    expect(
      benchmarkCcache(meta, build('build compiling debug\ncompilation cache 9 hits / 308 misses (2.8%)')),
    ).toMatchObject({
      status: 'investigate',
      builds: [{ hits: 9, misses: 308 }],
      invalidReasons: ['ccache-hit-rate-below-target'],
    });
    expect(benchmarkCcache(meta, build('compilation cache 80 hits / 20 misses (80%)')).status).toBe('measured');
  });

  it('accepts a proven artifact hit while refusing absent compiler evidence after a build', () => {
    expect(benchmarkCcache(meta, build('fingerprint abcdef.. hit (1s)')).status).toBe('artifact-hit');
    expect(benchmarkCcache(meta, build('build compiling debug\ncompilation cache unavailable'))).toMatchObject({
      status: 'investigate',
      invalidReasons: ['ccache-evidence-missing'],
    });
    expect(benchmarkCcache(meta, build(''))).toMatchObject({ status: 'investigate' });
    expect(benchmarkCcache({ ...meta, arm: 'control' }, [])).toMatchObject({
      status: 'not-applicable',
      invalidReasons: [],
    });
  });

  it('does not let a retry hide an earlier poorly cached build or stale doctor finding', () => {
    const commands = [
      ...build('build compiling debug\ncompilation cache 9 hits / 308 misses (2.8%)'),
      ...build('fingerprint abcdef.. hit'),
      { command: 'stim doctor --platform android', output: 'The configured CMake cache predates the ccache launcher' },
    ];
    expect(benchmarkCcache(meta, commands).invalidReasons).toEqual([
      'ccache-hit-rate-below-target',
      'stale-cmake-launcher-state',
    ]);
    expect(benchmarkCcache({ ...meta, timingTarget: {} }, commands).invalidReasons).toContain('ccache-target-missing');
  });

  it('does not let good retry evidence mask an earlier invocation with no evidence', () => {
    expect(benchmarkCcache(meta, [...build(''), ...build('fingerprint abcdef.. hit')]).invalidReasons).toContain(
      'ccache-evidence-missing',
    );
    expect(
      benchmarkCcache(meta, [...build(''), ...build('compilation cache 80 hits / 20 misses (80%)')]).invalidReasons,
    ).toContain('ccache-evidence-missing');
  });

  const noMetro =
    '  error       STIM_NO_METRO: No Metro port is reserved for this workspace.\n  remedy      Run `stim start` first.';
  const artifactHit = build(
    'fingerprint abcdef.. hit (1s)\ncompilation cache not run; artifact cache supplied the app',
  );

  it('does not blame the compiler cache for a STIM_NO_METRO refusal that precedes an artifact hit', () => {
    expect(benchmarkCcache(meta, [...refusal(noMetro), ...artifactHit])).toMatchObject({
      status: 'artifact-hit',
      invalidReasons: [],
    });
    const structured = JSON.stringify({ code: 'STIM_NO_METRO', message: 'Port 8082 is not held.', remedy: null });
    expect(benchmarkCcache(meta, [...refusal(structured), ...artifactHit])).toMatchObject({
      status: 'artifact-hit',
      invalidReasons: [],
    });
  });

  it('still flags a failed build that reports no compiler statistics', () => {
    const failed = 'build       compiling debug with Gradle\n  error       STIM_BUILD_FAILED: Gradle failed.';
    expect(benchmarkCcache(meta, [...refusal(failed), ...artifactHit]).invalidReasons).toContain(
      'ccache-evidence-missing',
    );
    expect(
      benchmarkCcache(meta, [...refusal(`${noMetro}\n  build       compiling debug with Gradle`), ...artifactHit])
        .invalidReasons,
    ).toContain('ccache-evidence-missing');
  });

  it('still flags an interrupted, killed, or crashed command that could have compiled', () => {
    expect(
      benchmarkCcache(meta, [...refusal('build       compiling debug with Gradle', null), ...artifactHit])
        .invalidReasons,
    ).toContain('ccache-evidence-missing');
    expect(benchmarkCcache(meta, [...refusal('', 137), ...artifactHit]).invalidReasons).toContain(
      'ccache-evidence-missing',
    );
    expect(
      benchmarkCcache(meta, [...refusal('TypeError: boom\n    at runAndroid (android.ts:1)'), ...artifactHit])
        .invalidReasons,
    ).toContain('ccache-evidence-missing');
    expect(benchmarkCcache(meta, [...refusal(noMetro, 0), ...artifactHit]).invalidReasons).toContain(
      'ccache-evidence-missing',
    );
  });

  it('still flags a refusal that is the only platform run', () => {
    expect(benchmarkCcache(meta, refusal(noMetro))).toMatchObject({
      status: 'investigate',
      builds: [],
      invalidReasons: ['ccache-evidence-missing'],
    });
  });

  it('measures structured Stim output for both collection and immediate alerts', () => {
    const output = JSON.stringify(
      { ok: true, facts: { ccache: { status: 'reported', hits: 80, misses: 20, hitRatePercent: 80 } } },
      null,
      2,
    );
    expect(benchmarkCcache(meta, build(output)).status).toBe('measured');
    expect(
      ccacheMeasurements(
        runnerToolOutput({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: output } }),
      ),
    ).toEqual([{ hits: 80, misses: 20, hitRatePercent: 80 }]);
    expect(
      benchmarkCcache(
        meta,
        build(JSON.stringify({ ok: true, facts: { ccache: { status: 'not-run', hits: null, misses: null } } })),
      ).status,
    ).toBe('artifact-hit');
  });

  it('retains every cache result when agents chain JSON and plain builds', () => {
    const good = JSON.stringify({ facts: { ccache: { status: 'reported', hits: 80, misses: 20 } } });
    const bad = JSON.stringify({ facts: { ccache: { status: 'reported', hits: 9, misses: 308 } } });
    const audit = benchmarkCcache(meta, [
      { ...build(`${good}\n${bad}`)[0], command: 'stim android --json; stim android --json' },
    ]);
    expect(audit.builds).toHaveLength(2);
    expect(audit.invalidReasons).toContain('ccache-hit-rate-below-target');
    expect(ccacheMeasurements(`${good}\ncompilation cache 9 hits / 308 misses (2.8%)`)).toHaveLength(2);
    expect(benchmarkCcache(meta, build(`${good}\ncompilation cache unavailable`)).invalidReasons).toContain(
      'ccache-evidence-missing',
    );
  });

  it('rejects dirty or incomplete doctor evidence before timing', () => {
    expect(() =>
      assertAndroidDoctorClean({ platform: 'android', findings: [{ level: 'cost', title: 'stale CMake' }] }),
    ).toThrow(/stale CMake/);
    expect(() => assertAndroidDoctorClean({ findings: [] })).toThrow(/invalid/);
    expect(assertAndroidDoctorClean({ platform: 'android', findings: [] })).toMatchObject({
      platform: 'android',
      findings: [],
    });
  });

  it('only extracts tool output for immediate alerts, including Claude tool results', () => {
    const output = 'compilation cache 9 hits / 308 misses (2.8%)';
    expect(
      runnerToolOutput({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: output } }),
    ).toBe(output);
    expect(
      runnerToolOutput({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: output }] }] },
      }),
    ).toBe(output);
    expect(runnerToolOutput({ type: 'item.completed', item: { type: 'agent_message', text: output } })).toBe('');
  });
});

describe('benchmark run guards', () => {
  it('selects and validates a machine target', () => {
    expect(benchmarkTarget(targetConfig, { platform: 'android', variant: 'native', arm: 'stim' })).toEqual({
      key: 'android.native.stim',
      machine: 'Test Mac',
      screenReadySeconds: 300,
      platformCommandSeconds: 180,
      runTimeoutSeconds: 600,
    });
    expect(() => benchmarkTarget(targetConfig, { platform: 'ios', variant: 'native', arm: 'stim' })).toThrow(
      /target missing/,
    );
    expect(() =>
      parseBenchmarkTargets({
        schemaVersion: 1,
        machine: 'Test Mac',
        targets: { 'android.native.stim': { screenReadySeconds: 300, runTimeoutSeconds: 200 } },
      }),
    ).toThrow(/at least screenReadySeconds/);
    expect(() =>
      parseBenchmarkTargets({
        schemaVersion: 1,
        machine: 'Test Mac',
        targets: {
          'android.native.stim': {
            screenReadySeconds: 100,
            platformCommandSeconds: 300,
            runTimeoutSeconds: 200,
          },
        },
      }),
    ).toThrow(/at least platformCommandSeconds/);
  });

  it('finds commands in shell chains without splitting quoted operators', () => {
    expect(shellCommandSegments(`/bin/zsh -lc 'cd "$WT" && echo "a && b"; stim guide agent'`)).toEqual([
      'cd "$WT"',
      'echo "a && b"',
      'stim guide agent',
    ]);
    const search = 'rg -n "run:android|agent-device|emulator" .';
    const body = `${search} | sed -n '1,180p'`;
    const wrapped = `/bin/zsh -lc ${JSON.stringify(body)}`;
    expect(shellCommandSegments(wrapped)).toEqual([search, "sed -n '1,180p'"]);
    expect(agentDeviceIsolationInvalidReasons([{ command: wrapped }], 'env expected agent-device ')).toEqual([]);
  });

  it('decodes one shell quoting layer while preserving proof command boundaries and literal backslashes', () => {
    const proof =
      'env AGENT_DEVICE_STATE_DIR=/tmp/bench AGENT_DEVICE_SESSION=run agent-device wait text "Offline maps"';
    expect(topLevelShellCommand(`/bin/zsh -lc ${JSON.stringify(proof)}`)).toBe(proof);
    expect(topLevelShellCommand(`/bin/zsh -lc ${JSON.stringify(`${proof}; agent-device close`)}`)).not.toBe(proof);
    const literal = "rg '\\d+\\s' file";
    expect(topLevelShellCommand(`/bin/zsh -lc ${JSON.stringify(literal)}`)).toBe(literal);
    expect(topLevelShellCommand('/bin/zsh -lc "echo \\$VALUE"')).toBe('echo $VALUE');
    expect(topLevelShellCommand('/bin/zsh -lc "echo \\q"')).toBe('echo \\q');
    const quotedNewline = "printf '%s' 'before" + '\\'.repeat(2) + "\nafter'";
    expect(topLevelShellCommand(`/bin/zsh -lc "${quotedNewline}"`)).toBe("printf '%s' 'before\\\nafter'");
    expect(topLevelShellCommand('/bin/zsh -lc "echo before\\\nafter"')).toBe('echo beforeafter');
    const apostrophe = `printf '%s' "it's ready"`;
    const quoted = "'" + apostrophe.replaceAll("'", "'\"'\"'") + "'";
    expect(topLevelShellCommand(`/bin/zsh -lc ${quoted}`)).toBe(apostrophe);
    expect(topLevelShellCommand('/bin/zsh -lc "echo ok"; cat app/_layout.tsx')).toBe(
      '/bin/zsh -lc "echo ok"; cat app/_layout.tsx',
    );
    expect(topLevelShellCommand('/bin/zsh -lc "unterminated')).toBe('/bin/zsh -lc "unterminated');
  });

  it.each(['zsh', 'bash', 'sh'])('audits non-login %s proof commands without hiding extra commands', (shell) => {
    const prefix = 'env AGENT_DEVICE_STATE_DIR=/tmp/bench AGENT_DEVICE_SESSION=run agent-device ';
    const proof = `${prefix}open com.appandflow.trailhead --foreground --platform android --serial emulator-5554`;
    const wrapped = `/bin/${shell} -c ${JSON.stringify(proof)}`;
    expect(topLevelShellCommand(wrapped)).toBe(proof);
    expect(agentDeviceIsolationInvalidReasons([{ command: wrapped }], prefix)).toEqual([]);
    const chained = `/bin/${shell} -c ${JSON.stringify(`${proof}; agent-device close`)}`;
    expect(topLevelShellCommand(chained)).not.toBe(proof);
    expect(agentDeviceIsolationInvalidReasons([{ command: chained }], prefix)).not.toEqual([]);
    const suffix = `${wrapped}; echo extra`;
    expect(topLevelShellCommand(suffix)).toBe(suffix);
  });

  it('rejects setup recovery inside the timer', () => {
    const commands = [
      { command: "/bin/zsh -lc 'stim guide agent'", exitCode: 1 },
      { command: "/bin/zsh -lc 'stim worktree warm'", exitCode: 1 },
      { command: "/bin/zsh -lc 'npm install'", exitCode: 0 },
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        exitCode: 0,
        output: 'fingerprint abcdef.. miss\nbuild ok',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([
      'dependencies-installed-inside-timer',
      'stim-guide-agent-missing-or-failed',
      'stim-worktree-warm-missing-or-failed',
      'stim-gradle-build-cache-missing',
    ]);
  });

  it('accepts a warm native build with the shared Gradle cache enabled', () => {
    const commands = [
      { command: "/bin/zsh -lc 'stim guide agent'", exitCode: 0 },
      { command: "/bin/zsh -lc 'stim worktree warm'", exitCode: 0, endEventOffset: 2 },
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        startEventOffset: 3,
        exitCode: 0,
        output: 'fingerprint abcdef.. miss\ncache gradle build cache on (--build-cache, shared)',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('uses reported warm status without losing completion ordering', () => {
    const meta = { arm: 'stim', platform: 'android' };
    const guide = { command: 'stim guide agent', exitCode: 0 };
    const start = { command: 'stim start', exitCode: 0, startEventOffset: 3 };
    for (const code of [0, 7]) {
      const command = 'cd /tmp && stim worktree warm; echo "EXIT=$?"';
      const result = spawnSync('/bin/bash', ['-c', `stim() { return ${code}; }; ${command}`], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      const warm = { command, exitCode: result.status, output: result.stdout, endEventOffset: 2 };
      expect(benchmarkSetupInvalidReasons(meta, [guide, warm, start])).toEqual(
        code === 0 ? [] : ['stim-worktree-warm-missing-or-failed'],
      );
      if (code !== 0) continue;
      expect(benchmarkSetupInvalidReasons(meta, [guide, { ...warm, endEventOffset: 4 }, start])).toEqual([
        'stim-worktree-warm-not-complete-before-use',
      ]);
      for (const output of ['', 'EXIT=0\nEXIT=0\n', 'EXIT=7\n']) {
        expect(benchmarkSetupInvalidReasons(meta, [guide, { ...warm, output }, start])).toContain(
          'stim-worktree-warm-missing-or-failed',
        );
      }
      const background = { ...warm, command: 'stim worktree warm &\necho "EXIT=$?"' };
      expect(benchmarkSetupInvalidReasons(meta, [guide, background, start])).toContain(
        'stim-worktree-warm-missing-or-failed',
      );
    }
  });

  it('audits Claude-style chained commands', () => {
    const commands = [
      { command: `/bin/zsh -lc 'cd "$WT" && stim guide agent'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'cd "$WT" && stim worktree warm'`, exitCode: 0, endEventOffset: 2 },
      { command: `/bin/zsh -lc 'cd "$WT" && npm install'`, exitCode: 0, startEventOffset: 3 },
      {
        command: `/bin/zsh -lc 'cd "$WT" && stim android --system-image image'`,
        startEventOffset: 4,
        exitCode: 0,
        elapsedSeconds: 346,
        output: 'fingerprint abcdef.. miss\nbuild ok',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([
      'dependencies-installed-inside-timer',
      'stim-gradle-build-cache-missing',
    ]);
    const target = benchmarkTarget(targetConfig, { platform: 'android', variant: 'native', arm: 'stim' });
    expect(benchmarkTiming(target, commands, 400, false)).toMatchObject({
      platformCommandSeconds: 346,
      platformCommandTargetMet: false,
      invalidReasons: ['platform-command-target-exceeded'],
    });
  });

  it.each(['stim start', 'stim ios', 'stim android', 'npm install'])(
    'rejects %s starting before warm finishes even when warm eventually succeeds',
    (command) => {
      const commands = [
        { command: 'stim guide agent', exitCode: 0 },
        {
          command,
          exitCode: 0,
          startedAt: '2026-09-07T12:01:00Z',
          endedAt: '2026-09-07T12:01:05Z',
        },
        {
          command: 'stim worktree warm',
          exitCode: 0,
          startedAt: '2026-09-07T12:00:00Z',
          endedAt: '2026-09-07T12:01:30Z',
        },
      ];
      expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toContain(
        'stim-worktree-warm-not-complete-before-use',
      );
      expect(benchmarkSetupInvalidReasons({ arm: 'control', platform: 'android' }, commands)).toEqual(
        command === 'npm install' ? ['dependencies-installed-inside-timer'] : [],
      );
      commands[1].startedAt = '2026-09-07T12:01:31Z';
      commands[1].endedAt = '2026-09-07T12:01:32Z';
      expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual(
        command === 'npm install' ? ['dependencies-installed-inside-timer'] : [],
      );
    },
  );

  it('uses event order for equal timestamps and refuses unknown or ambiguous warm completion', () => {
    const warm = {
      command: 'stim worktree warm',
      exitCode: 0,
      startedAt: '2026-09-07T12:00:00Z',
      endedAt: '2026-09-07T12:01:00Z',
      startEventOffset: 1,
      endEventOffset: 4,
    };
    const start = {
      command: 'stim start',
      exitCode: 0,
      startedAt: '2026-09-07T12:01:00Z',
      endedAt: '2026-09-07T12:01:01Z',
      startEventOffset: 3,
      endEventOffset: 5,
    };
    const meta = { arm: 'stim', platform: 'ios' };
    const commands = [{ command: 'stim guide agent', exitCode: 0 }, warm, start];
    expect(benchmarkSetupInvalidReasons(meta, commands)).toEqual(['stim-worktree-warm-not-complete-before-use']);
    warm.endEventOffset = 2;
    expect(benchmarkSetupInvalidReasons(meta, commands)).toEqual([]);
    for (const unproven of [
      { ...warm, parallelTimingAmbiguous: true },
      { ...warm, endedAt: undefined, endEventOffset: undefined },
    ]) {
      expect(benchmarkSetupInvalidReasons(meta, [commands[0], unproven, start])).toEqual([
        'stim-worktree-warm-not-complete-before-use',
      ]);
    }
  });

  it('does not let an earlier warm hide a second overlapping warm or a launch before setup', () => {
    const guide = { command: 'stim guide agent', exitCode: 0 };
    const warm = { command: 'stim worktree warm', exitCode: 0, startEventOffset: 1, endEventOffset: 2 };
    const start = { command: 'stim start', exitCode: 0, startEventOffset: 4, endEventOffset: 6 };
    const secondWarm = { ...warm, startEventOffset: 3, endEventOffset: 5 };
    const meta = { arm: 'stim', platform: 'ios' };
    expect(benchmarkSetupInvalidReasons(meta, [guide, warm, start, secondWarm])).toEqual([
      'stim-worktree-warm-not-complete-before-use',
    ]);
    secondWarm.startEventOffset = 7;
    secondWarm.endEventOffset = 8;
    expect(benchmarkSetupInvalidReasons(meta, [guide, warm, start, secondWarm])).toEqual([]);
    expect(benchmarkSetupInvalidReasons(meta, [guide, start, secondWarm])).toEqual([
      'stim-worktree-warm-not-complete-before-use',
    ]);
  });

  it('does not let a later successful command mask failed setup', () => {
    const commands = [
      { command: `/bin/zsh -lc 'stim guide agent; true'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'stim worktree warm\ntrue'`, exitCode: 0 },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'ios' }, commands)).toEqual([
      'stim-guide-agent-missing-or-failed',
      'stim-worktree-warm-missing-or-failed',
    ]);
  });

  it('reports target status without treating model latency as invalid', () => {
    const target = benchmarkTarget(targetConfig, { platform: 'android', variant: 'native', arm: 'stim' });
    const commands = [
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        elapsedSeconds: 346,
      },
    ];
    expect(benchmarkTiming(target, commands, 502, false)).toMatchObject({
      screenReadyTargetMet: false,
      platformCommandTargetMet: false,
      invalidReasons: ['platform-command-target-exceeded'],
    });
  });

  it('requires exact timed-shell Stim provenance', () => {
    const expected = {
      resolvedPath: '/bench/bin/stim',
      version: '1.0.0-rc.15',
      executableSha256: 'shim',
      cliSha256: 'cli',
    };
    expect(
      stimShellProvenanceInvalidReasons({
        arm: 'stim',
        expectedStimShellProvenance: expected,
        stimShellProvenance: expected,
      }),
    ).toEqual([]);
    expect(
      stimShellProvenanceInvalidReasons({
        arm: 'stim',
        expectedStimShellProvenance: expected,
        stimShellProvenance: { ...expected, version: '1.0.0-rc.14' },
      }),
    ).toEqual(['stim-shell-provenance-mismatch']);
  });
});
