import { LatestFrames } from '../src/frame-delivery.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.clearAllTimers());

it('keeps only the latest JPEG while congested and cancels pending delivery on stop', () => {
  const sent: string[] = [];
  let buffered = 1000;
  const delivery = new LatestFrames<{ data: string }>(
    10,
    () => buffered,
    (frame) => sent.push(frame.data),
  );
  delivery.push({ data: 'old' });
  vi.advanceTimersByTime(200);
  delivery.push({ data: 'latest' });
  expect(sent).toEqual([]);
  buffered = 0;
  vi.advanceTimersByTime(50);
  expect(sent).toEqual(['latest']);
  delivery.push({ data: 'cancelled' });
  delivery.stop();
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual(['latest']);
});
