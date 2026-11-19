import { awakeTimeout } from '../stimd/awake-timer.ts';

const MINUTE_MS = 60_000;

test('ten awake minutes fire the timer, and not one step earlier', async () => {
  const fire = vi.fn<() => void>();
  awakeTimeout(10 * MINUTE_MS, fire);

  await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 5000);
  expect(fire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fire).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
  expect(fire).toHaveBeenCalledTimes(1);
});

test('an overnight sleep after nine awake minutes does not fire the timer; one more awake minute does', async () => {
  let asleep = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => now() + asleep);
  const fire = vi.fn<() => void>();
  awakeTimeout(10 * MINUTE_MS, fire);

  await vi.advanceTimersByTimeAsync(9 * MINUTE_MS);
  asleep += 8 * 60 * MINUTE_MS;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fire).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(MINUTE_MS - 5000);
  expect(fire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fire).toHaveBeenCalledTimes(1);
});
