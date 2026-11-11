import { describe, expect, it } from 'vitest';
import { PLATFORMS, benchmarkCell } from '../../../scripts/agent-benchmark/matrix.mjs';
import { coveragePlatforms } from './benchmarkCoverage';

describe('benchmark coverage table', () => {
  it('lists the harness platforms and marks the arms the harness does not support', () => {
    expect(coveragePlatforms.map((platform) => platform.id)).toEqual(PLATFORMS.map((platform) => platform.id));
    for (const platform of coveragePlatforms) {
      const scenario = 'launch';
      for (const [arm, status] of Object.entries(platform.arms)) {
        expect(status === 'not-applicable').toBe(benchmarkCell(platform.id, scenario, arm).status === 'unsupported');
      }
    }
  });
});
