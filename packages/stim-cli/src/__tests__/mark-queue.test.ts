import {
  acquireDisk,
  CRITICAL,
  HARD_FLOOR,
  LADDER,
  LANE,
  MarkInterrupted,
  requestGcItem,
  requestMark,
} from '../daemon/disk-owner.ts';
import { keepReserve, releaseReserve } from '../disk-reserve.ts';

vi.mock('../disk-reserve.ts', () => ({ keepReserve: vi.fn<() => void>(), releaseReserve: vi.fn<() => void>() }));

afterEach(() => vi.clearAllMocks());

test.each([HARD_FLOOR, CRITICAL, LADDER])(
  'pressure rank%i aborts a root, waits for cleanup, then owns the disk',
  async (rank) => {
    let finish = () => {};
    let signal: AbortSignal | undefined;
    const root = requestMark((active) => {
      signal = active;
      return new Promise<void>((_resolve, reject) => {
        finish = () => reject(active.reason);
      });
    });
    const result = root.result.catch((error: unknown) => error);
    await vi.waitFor(() => expect(signal).toBeDefined());
    let granted = false;
    const pressure = acquireDisk(rank).then((turn) => {
      granted = true;
      return turn;
    });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(granted).toBe(false);
    finish();
    expect(await result).toBeInstanceOf(MarkInterrupted);
    const turn = await pressure;
    expect(granted).toBe(true);
    root.leave();
    let next = false;
    const pending = acquireDisk(LANE).then((taken) => {
      next = true;
      return taken;
    });
    await Promise.resolve();
    expect(next).toBe(false);
    turn.release();
    (await pending).release();
    expect(keepReserve).not.toHaveBeenCalled();
    expect(releaseReserve).not.toHaveBeenCalled();
  },
);

test('a normal lane or item waits for the bounded root without aborting it', async () => {
  let finish = () => {};
  let signal: AbortSignal | undefined;
  const root = requestMark((active) => {
    signal = active;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await vi.waitFor(() => expect(signal).toBeDefined());
  const order: string[] = [];
  const lane = acquireDisk(LANE).then((turn) => {
    order.push('lane');
    turn.release();
    return undefined;
  });
  const item = requestGcItem(async () => {
    order.push('item');
  });
  expect(signal?.aborted).toBe(false);
  expect(order).toEqual([]);
  finish();
  await root.result;
  await item.result;
  await lane;
  expect(order).toEqual(['item', 'lane']);
});

test('pressure already queued cancels a queued mark without starting or releasing the current owner', async () => {
  const lane = await acquireDisk(LANE);
  const pressure = acquireDisk(CRITICAL);
  const work = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const root = requestMark(work);
  await expect(root.result).rejects.toBeInstanceOf(MarkInterrupted);
  expect(work).not.toHaveBeenCalled();
  let granted = false;
  void pressure.then(() => {
    granted = true;
    return undefined;
  });
  await Promise.resolve();
  expect(granted).toBe(false);
  lane.release();
  (await pressure).release();
});

test('a caller leaving a queued mark withdraws only that ticket', async () => {
  const lane = await acquireDisk(LANE);
  const work = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const root = requestMark(work);
  root.leave();
  await expect(root.result).rejects.toMatchObject({ name: 'AbortError' });
  expect(work).not.toHaveBeenCalled();
  const next = acquireDisk(LANE);
  let granted = false;
  void next.then(() => {
    granted = true;
    return undefined;
  });
  await Promise.resolve();
  expect(granted).toBe(false);
  lane.release();
  (await next).release();
});
