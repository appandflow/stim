import { describe, expect, it } from 'vitest';
import {
  assignCommandLanes,
  benchmarkSelectionFromSearch,
  benchmarkOverview,
  comparisonOutcome,
  commandAtCursor,
  initialAuditSelection,
  timeBreakdown,
  type BenchmarkData,
  type BenchmarkCommand,
  type BenchmarkRun,
} from './benchmarkData';

const navigationBenchmarks = [
  {
    stage: 'luna-rc12',
    runs: [
      { id: 'javascript-stim', valid: true },
      { id: 'native-stim', valid: true },
      { id: 'luna-invalid', valid: false },
    ],
  },
  {
    stage: 'sol-rc12',
    runs: [
      { id: 'javascript-stim', valid: true },
      { id: 'native-stim', valid: true },
    ],
  },
] as BenchmarkData[];

function command(id: string, startSeconds: number, endSeconds: number): BenchmarkCommand {
  return { id, startSeconds, endSeconds, command: id, output: '', exitCode: 0 };
}

describe('assignCommandLanes', () => {
  it('puts concurrent commands on separate rows and reuses rows after completion', () => {
    const result = assignCommandLanes([command('long', 1, 10), command('concurrent', 2, 4), command('later', 4, 7)]);

    expect(result.laneCount).toBe(2);
    expect(result.commands.map(({ id, lane }) => [id, lane])).toEqual([
      ['long', 0],
      ['concurrent', 1],
      ['later', 1],
    ]);
  });
});

describe('benchmarkOverview', () => {
  it('links a platform-filtered overview to the matching run in the full catalog', () => {
    const android = {
      stage: 'luna-android',
      title: 'Luna Android',
      runs: [{ id: 'javascript-stim', arm: 'stim', variant: 'javascript', valid: true, settingsReadySeconds: 161 }],
    } as BenchmarkData;
    const overview = benchmarkOverview([android], 'javascript');
    const href = overview.rows[0]?.arms[0]?.href;
    expect(href).toBeTruthy();
    const url = new URL(href!, 'https://example.test');

    expect(benchmarkSelectionFromSearch(url.search, [...navigationBenchmarks, android])).toEqual({
      stage: 'luna-android',
      runId: 'javascript-stim',
    });
  });
});

describe('comparisonOutcome', () => {
  it('describes both faster and slower Stim results without negative percentages', () => {
    expect(comparisonOutcome(80, 100)).toEqual({ label: 'Stim reached Settings 20% sooner', tone: 'gain' });
    expect(comparisonOutcome(108, 100)).toEqual({ label: 'Stim reached Settings 8% slower', tone: 'loss' });
  });

  it('handles equal and unavailable comparisons', () => {
    expect(comparisonOutcome(100, 100)).toEqual({
      label: 'Stim and control reached Settings in the same time',
      tone: 'neutral',
    });
    expect(comparisonOutcome(null, 100)).toEqual({ label: 'Matched run unavailable', tone: 'neutral' });
  });
});

describe('initialAuditSelection', () => {
  it('returns an empty audit state when an invalid run has no events or proof', () => {
    const run = {
      valid: false,
      commands: [],
      markers: [],
      messages: [],
      proof: null,
    } as unknown as BenchmarkRun;

    expect(initialAuditSelection(run)).toBeNull();
  });
});

describe('timeBreakdown', () => {
  it('uses command interval union for wall time and reports concurrency separately', () => {
    const run = {
      totalSeconds: 20,
      commands: [command('first', 2, 10), command('overlap', 5, 8), command('later', 12, 15)],
    } as BenchmarkRun;

    expect(timeBreakdown(run)).toEqual({
      shellActiveSeconds: 11,
      agentOtherSeconds: 9,
      summedCommandSeconds: 14,
      peakConcurrency: 2,
    });
  });
});

describe('commandAtCursor', () => {
  const commands = [command('first', 2, 10), command('overlap', 5, 8), command('later', 12, 15)];

  it('shows the most recently started active command without revealing its final output', () => {
    expect(commandAtCursor(commands, 6)).toEqual({ command: commands[1], state: 'running' });
  });

  it('keeps the most recently completed command visible between events', () => {
    expect(commandAtCursor(commands, 11)).toEqual({ command: commands[0], state: 'complete' });
    expect(commandAtCursor(commands, 0)).toBeNull();
  });
});
