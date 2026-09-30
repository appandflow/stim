import { formatBytes, formatDuration, formatMemoryMb, formatSize } from '@/intl/format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('formatDuration', () => {
  it('floors to the largest unit, with minutes under a day', () => {
    expect(
      [-5, 59_999, MINUTE, 59 * MINUTE, HOUR, HOUR + 3 * MINUTE, 24 * HOUR, 71 * HOUR].map((ms) => formatDuration(ms)),
    ).toEqual(['<1m', '<1m', '1m', '59m', '1h', '1h03m', '1d', '2d']);
  });

  it('keeps only the largest unit when coarse, so hours never carry padded minutes', () => {
    expect(
      [30_000, 42 * MINUTE, 102 * MINUTE, 1207 * MINUTE, 49 * HOUR].map((ms) => formatDuration(ms, { coarse: true })),
    ).toEqual(['<1m', '42m', '1h', '20h', '2d']);
  });

  it('counts seconds under a minute when asked', () => {
    expect([0, 40_900, MINUTE].map((ms) => formatDuration(ms, { seconds: true }))).toEqual(['0s', '40s', '1m']);
  });
});

describe('sizes', () => {
  it('keeps the rounding and thresholds of the per-screen formatters it replaced', () => {
    expect(formatBytes(3.25e9)).toBe('3.3 GB');
    expect(formatBytes(99.96e9)).toBe('100.0 GB');
    expect(formatBytes(212.4e9)).toBe('212 GB');
    expect(formatBytes(1.25e12)).toBe('1.3 TB');
  });

  it('goes down to kilobytes and says None for nothing', () => {
    expect([0, 400, 999_600, 5e6, 123.44e9].map(formatSize)).toEqual(['None', '1 KB', '1000 KB', '5 MB', '123.4 GB']);
  });

  it('shows memory in binary units', () => {
    expect([512.4, 1023.6, 1536].map(formatMemoryMb)).toEqual(['512 MB', '1024 MB', '1.5 GB']);
  });
});
