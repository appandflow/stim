import { describe, expect, it } from 'vitest';
import { maxWorkersFor } from './test-max-workers.mjs';

describe('maxWorkersFor', () => {
  it.each([
    [{ cores: 14, load1: 0 }, 7],
    [{ cores: 14, load1: 3.4 }, 7],
    [{ cores: 14, load1: 8 }, 5],
    [{ cores: 14, load1: 178 }, 2],
    [{ cores: 4, load1: 0 }, 2],
    [{ cores: 8, load1: 1 }, 4],
    [{ cores: 2, load1: 0 }, 1],
    [{ cores: 1, load1: 0 }, 1],
  ])('%j gives %i workers', (machine, workers) => {
    expect(maxWorkersFor(machine)).toBe(workers);
  });
});
