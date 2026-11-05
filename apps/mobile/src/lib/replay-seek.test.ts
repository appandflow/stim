import { DRAG_SLOP, SEEK_INTERVAL_MS, SeekQueue, scrubEndRate, scrubMove, scrubStart } from './replay-seek';

describe('the seek queue', () => {
  it('keeps one seek out and only the latest waiting, and shows only the latest answer', () => {
    const queue = new SeekQueue();
    const first = { at: 1, rate: 0 as const };
    queue.ask(first);
    expect(queue.next(0, true)).toBe(first);
    queue.ask({ at: 2, rate: 0 });
    const latest = { at: 3, rate: 0 as const };
    queue.ask(latest);
    expect(queue.next(SEEK_INTERVAL_MS, true)).toBeNull();
    expect(queue.finish(first)).toBe(false);
    expect(queue.next(SEEK_INTERVAL_MS, true)).toBe(latest);
    expect(queue.finish(latest)).toBe(true);
    expect(queue.settled).toBe(true);
  });

  it('holds a seek until the subscription opens and the interval passes', () => {
    const queue = new SeekQueue();
    const first = { at: 1, rate: 0 as const };
    queue.ask(first);
    expect(queue.next(0, false)).toBeNull();
    expect(queue.next(0, true)).toBe(first);
    queue.finish(first);
    queue.ask({ at: 2, rate: 0 });
    expect(queue.next(10, true)).toBeNull();
    expect(queue.delay(10, true)).toBe(SEEK_INTERVAL_MS - 10);
    expect(queue.next(SEEK_INTERVAL_MS, true)).toEqual({ at: 2, rate: 0 });
  });

  it('never shows the answer to a seek sent before it was cleared', () => {
    const queue = new SeekQueue();
    const seek = { at: 1, rate: 1 as const };
    queue.ask(seek);
    queue.next(0, true);
    queue.clear();
    expect(queue.finish(seek)).toBe(false);
  });
});

describe('a finger on the replay track', () => {
  it('pauses a playing replay once it drags, and plays on when it lifts', () => {
    const touch = scrubStart(100);
    expect(scrubMove(touch, 100 + DRAG_SLOP - 1, true).drag).toBeNull();
    const dragging = scrubMove(touch, 100 + DRAG_SLOP, true);
    expect(dragging.drag).toEqual({ resume: true });
    const moved = scrubMove(dragging, 180, false);
    expect(scrubEndRate(moved, false, 2)).toBe(2);
  });

  it('leaves a paused replay paused after a drag', () => {
    const dragging = scrubMove(scrubStart(100), 150, false);
    expect(scrubEndRate(dragging, false, 1)).toBe(0);
  });

  it('keeps the replay playing or paused on a tap', () => {
    const tap = scrubMove(scrubStart(100), 102, true);
    expect(scrubEndRate(tap, true, 1)).toBe(1);
    expect(scrubEndRate(tap, false, 1)).toBe(0);
  });
});
