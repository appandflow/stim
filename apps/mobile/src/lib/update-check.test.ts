import { UPDATE_CHECK_MIN_INTERVAL_MS, updateCheckDue } from '@/lib/update-check';

describe('updateCheckDue', () => {
  it('is due before any check has run', () => {
    expect(updateCheckDue(null, 1000)).toBe(true);
  });

  it('is not due within the throttle window', () => {
    expect(updateCheckDue(1000, 1000 + UPDATE_CHECK_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  it('is due once the window has passed', () => {
    expect(updateCheckDue(1000, 1000 + UPDATE_CHECK_MIN_INTERVAL_MS)).toBe(true);
  });
});
