import { describe, expect, it } from 'vitest';
import { timeBenchmarkFromFirstActivity } from './benchmark-timing.mjs';

function fixture() {
  return {
    suite: 'launch-crash',
    runs: [
      {
        id: 'launch-crash-stim',
        arm: 'stim',
        settingsReadySeconds: 200,
        diagnosisSeconds: 170,
        appAliveSeconds: 160,
        totalSeconds: 230,
        usage: { input_tokens: 500 },
        estimatedTokenCostUsd: 0.5,
        messages: [{ id: 'message', atSeconds: 95 }],
        commands: [{ id: 'command', startSeconds: 98, endSeconds: 150, output: '52s' }],
        backgroundProcesses: [{ id: 'background', startSeconds: 100, endSeconds: 180 }],
        markers: [{ id: 'settings', atSeconds: 200 }],
      },
    ],
  };
}

describe('benchmark activity timing', () => {
  it('shifts every timeline lane and endpoint together without changing duration, usage or raw input', () => {
    const original = fixture();
    const run = timeBenchmarkFromFirstActivity(original).runs[0];
    expect(run).toMatchObject({
      settingsReadySeconds: 105,
      diagnosisSeconds: 75,
      appAliveSeconds: 65,
      totalSeconds: 135,
    });
    expect(run.messages[0].atSeconds).toBe(0);
    expect(run.commands[0]).toMatchObject({ startSeconds: 3, endSeconds: 55, output: '52s' });
    expect(run.backgroundProcesses[0]).toMatchObject({ startSeconds: 5, endSeconds: 85 });
    expect(run.markers[0].atSeconds).toBe(run.settingsReadySeconds);
    expect(run.timingOrigin).toMatchObject({
      dispatchOffsetSeconds: 95,
      event: { kind: 'message', id: 'message' },
      dispatchSettingsReadySeconds: 200,
      dispatchDiagnosisSeconds: 170,
      dispatchTotalSeconds: 230,
    });
    expect(run.usage).toEqual(original.runs[0].usage);
    expect(run.estimatedTokenCostUsd).toBe(0.5);
    expect(original.runs[0].settingsReadySeconds).toBe(200);
  });

  it('uses a command when it precedes messages and applies the same rule to control', () => {
    const data = fixture();
    data.runs[0].arm = 'control';
    data.runs[0].messages[0].atSeconds = 160;
    const run = timeBenchmarkFromFirstActivity(data).runs[0];
    expect(run.timingOrigin).toMatchObject({ dispatchOffsetSeconds: 98, event: { kind: 'command' } });
    expect(run.commands[0].startSeconds).toBe(0);
    expect(run.settingsReadySeconds).toBe(102);
  });

  it('does not subtract startup twice on an already converted publication', () => {
    const once = timeBenchmarkFromFirstActivity(fixture());
    expect(timeBenchmarkFromFirstActivity(once)).toEqual(once);
  });

  it('preserves unavailable endpoints and refuses absent activity or contradictory evidence', () => {
    const data = fixture();
    data.runs[0].appAliveSeconds = null;
    expect(timeBenchmarkFromFirstActivity(data).runs[0].appAliveSeconds).toBeNull();
    data.runs[0].settingsReadySeconds = 10;
    expect(() => timeBenchmarkFromFirstActivity(data)).toThrow('Invalid event time');
    data.runs[0].messages = [];
    data.runs[0].commands = [];
    expect(() => timeBenchmarkFromFirstActivity(data)).toThrow('No recorded activity');
  });
});
