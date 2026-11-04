import { createTouchTracker, type FingerPoint, type TouchMessage } from './touch-tracker';

const p = (x: number, y: number): FingerPoint => ({ x, y });
const m = (phase: TouchMessage['phase'], first: FingerPoint, second?: FingerPoint): TouchMessage =>
  second ? { phase, first, second } : { phase, first };

describe('createTouchTracker', () => {
  it('holds the first finger so that a second one starts a two-finger gesture, not a tap', () => {
    const tracker = createTouchTracker();
    expect(tracker.down(1, p(0.25, 0.5))).toEqual([]);
    expect(tracker.pending).toBe(true);
    expect(tracker.down(2, p(0.75, 0.5))).toEqual([m('down', p(0.25, 0.5), p(0.75, 0.5))]);
    expect(tracker.settle()).toEqual([]);
    expect(tracker.move([[2, p(0.8, 0.5)]])).toEqual([m('move', p(0.25, 0.5), p(0.8, 0.5))]);
    expect(
      tracker.move([
        [1, p(0.2, 0.5)],
        [2, p(0.85, 0.5)],
      ]),
    ).toEqual([m('move', p(0.2, 0.5), p(0.85, 0.5))]);
    expect(tracker.down(3, p(0.5, 0.5))).toEqual([]);
    expect(tracker.up(1)).toEqual([m('up', p(0.2, 0.5), p(0.85, 0.5))]);
    expect(tracker.move([[2, p(0.7, 0.5)]])).toEqual([]);
    expect(tracker.up(2)).toEqual([]);
    expect(tracker.up(3)).toEqual([]);
    expect(tracker.down(4, p(0.5, 0.5))).toEqual([]);
    expect(tracker.pending).toBe(true);
  });

  it('sends a single finger once it settles, moves or lifts', () => {
    const tracker = createTouchTracker();
    tracker.down(1, p(0.5, 0.5));
    expect(tracker.settle()).toEqual([m('down', p(0.5, 0.5))]);
    expect(tracker.move([[1, p(0.5, 0.6)]])).toEqual([m('move', p(0.5, 0.6))]);
    expect(tracker.up(1)).toEqual([m('up', p(0.5, 0.6))]);

    tracker.down(2, p(0.1, 0.1));
    expect(tracker.move([[2, p(0.2, 0.2)]])).toEqual([m('down', p(0.1, 0.1)), m('move', p(0.2, 0.2))]);
    tracker.up(2);

    tracker.down(3, p(0.3, 0.3));
    expect(tracker.up(3)).toEqual([m('down', p(0.3, 0.3)), m('up', p(0.3, 0.3))]);
  });

  it('lifts the settled finger and presses both when a second one lands later', () => {
    const tracker = createTouchTracker();
    tracker.down(1, p(0.25, 0.5));
    tracker.settle();
    expect(tracker.down(2, p(0.75, 0.5))).toEqual([m('up', p(0.25, 0.5)), m('down', p(0.25, 0.5), p(0.75, 0.5))]);
  });

  it('lifts what is down when cancelled and starts clean afterwards', () => {
    const tracker = createTouchTracker();
    tracker.down(1, p(0.25, 0.5));
    expect(tracker.cancel()).toEqual([]);
    tracker.down(2, p(0.25, 0.5));
    tracker.down(3, p(0.75, 0.5));
    tracker.move([[3, p(0.8, 0.5)]]);
    expect(tracker.cancel()).toEqual([m('up', p(0.25, 0.5), p(0.8, 0.5))]);
    expect(tracker.up(2)).toEqual([]);
    expect(tracker.down(4, p(0.1, 0.1))).toEqual([]);
    expect(tracker.pending).toBe(true);
  });
});
