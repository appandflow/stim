import { describe, expect, it } from 'vitest';
import {
  agentDeviceIsolationInvalidReasons,
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

describe('agent-device session isolation', () => {
  const prefix = 'env AGENT_DEVICE_STATE_DIR=/tmp/bench-state AGENT_DEVICE_SESSION=bench-run agent-device ';

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

  it('rejects delayed daemon recovery even with the correct session', () => {
    expect(agentDeviceIsolationInvalidReasons([{ command: `sleep 5; ${prefix}daemon stop --clean` }], prefix)).toEqual([
      'agent-device-daemon-recovery-inside-timer',
    ]);
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
      { command: "/bin/zsh -lc 'stim worktree warm'", exitCode: 0 },
      {
        command: "/bin/zsh -lc 'stim android --system-image image'",
        exitCode: 0,
        output: 'fingerprint abcdef.. miss\ncache gradle build cache on (--build-cache, shared)',
      },
    ];
    expect(benchmarkSetupInvalidReasons({ arm: 'stim', platform: 'android' }, commands)).toEqual([]);
  });

  it('audits Claude-style chained commands', () => {
    const commands = [
      { command: `/bin/zsh -lc 'cd "$WT" && stim guide agent'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'cd "$WT" && stim worktree warm'`, exitCode: 0 },
      { command: `/bin/zsh -lc 'cd "$WT" && npm install'`, exitCode: 0 },
      {
        command: `/bin/zsh -lc 'cd "$WT" && stim android --system-image image'`,
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
