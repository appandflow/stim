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

test('a sleep of several hours counts as one minute, so the machine waking does not fire the timer', async () => {
  let asleep = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, 'now').mockImplementation(() => now() + asleep);
  const fire = vi.fn<() => void>();
  awakeTimeout(10 * MINUTE_MS, fire);

  await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
  asleep += 6 * 60 * MINUTE_MS;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fire).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(7 * MINUTE_MS - 5000);
  expect(fire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fire).toHaveBeenCalledTimes(1);
});
