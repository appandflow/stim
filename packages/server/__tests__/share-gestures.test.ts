import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Point = { x: number; y: number };
type Message = { type: 'touch'; phase: string; x: number; y: number; x2?: number; y2?: number };
interface Gestures {
  TwoFingerPositions: new () => {
    first: Point;
    second: Point;
    update: (pointer: Point, translating: boolean) => void;
  };
  createMirroredGesture: () => {
    active: boolean;
    pair: Point[] | null;
    hover: (pointer: Point, shift: boolean) => void;
    down: (pointer: Point, shift: boolean) => Message[];
    move: (pointer: Point, shift: boolean, option: boolean) => Message[];
    up: (pointer: Point, shift: boolean) => Message[];
    release: () => Message[];
  };
  createTouchTracker: () => {
    pending: boolean;
    down: (id: number, point: Point) => Message[];
    move: (id: number, point: Point) => Message[];
    up: (id: number) => Message[];
    settle: () => Message[];
  };
}

const gestures: Gestures = runInNewContext(
  `${readFileSync(new URL('../share-viewer/gestures.js', import.meta.url), 'utf8')}\nglobalThis.stimGestures`,
);

const touch = (phase: string, first: Point, second?: Point): Message => ({
  type: 'touch',
  phase,
  x: first.x,
  y: first.y,
  ...(second ? { x2: second.x, y2: second.y } : {}),
});
const p = (x: number, y: number): Point => ({ x, y });

describe('Option-drag fingers', () => {
  it('mirrors the second finger through the center and keeps both on the screen', () => {
    const positions = new gestures.TwoFingerPositions();
    positions.update(p(0.3, 0.4), false);
    expect(positions.first).toEqual(p(0.3, 0.4));
    expect(positions.second).toEqual({ x: 0.7, y: 0.6 });
    positions.update(p(0, 0), false);
    expect(positions.first).toEqual(p(0, 0));
    expect(positions.second).toEqual(p(1, 1));
  });

  it('moves both fingers together, a pan, while Shift is held', () => {
    const positions = new gestures.TwoFingerPositions();
    positions.update(p(0.3, 0.4), false);
    positions.update(p(0.35, 0.45), true);
    positions.update(p(0.4, 0.5), true);
    expect(positions.first.x).toBeCloseTo(0.35);
    expect(positions.first.y).toBeCloseTo(0.45);
    expect(positions.second.x).toBeCloseTo(0.75);
    expect(positions.second.y).toBeCloseTo(0.65);
  });

  it('sends down, moves and up with both fingers, and lifts both when Option is released mid-drag', () => {
    const gesture = gestures.createMirroredGesture();
    expect(gesture.pair).toBeNull();
    gesture.hover(p(0.3, 0.5), false);
    expect(gesture.pair).toEqual([p(0.3, 0.5), p(0.7, 0.5)]);
    expect(gesture.down(p(0.3, 0.5), false)).toEqual([touch('down', p(0.3, 0.5), p(0.7, 0.5))]);
    expect(gesture.move(p(0.4, 0.5), false, true)).toEqual([touch('move', p(0.4, 0.5), p(0.6, 0.5))]);
    expect(gesture.up(p(0.45, 0.5), false)).toEqual([touch('up', p(0.45, 0.5), p(0.55, 0.5))]);
    expect(gesture.up(p(0.45, 0.5), false)).toEqual([]);

    gesture.down(p(0.3, 0.5), false);
    expect(gesture.move(p(0.4, 0.5), false, false)).toEqual([touch('up', p(0.3, 0.5), p(0.7, 0.5))]);
    expect(gesture.active).toBe(false);
    expect(gesture.move(p(0.5, 0.5), false, true)).toEqual([]);

    gesture.down(p(0.2, 0.5), false);
    expect(gesture.release()).toEqual([touch('up', p(0.2, 0.5), p(0.8, 0.5))]);
    expect(gesture.pair).toBeNull();
  });
});

describe('real touches', () => {
  it('holds the first finger so that a second one starts a two-finger gesture, not a tap', () => {
    const tracker = gestures.createTouchTracker();
    expect(tracker.down(1, p(0.25, 0.5))).toEqual([]);
    expect(tracker.pending).toBe(true);
    expect(tracker.down(2, p(0.75, 0.5))).toEqual([touch('down', p(0.25, 0.5), p(0.75, 0.5))]);
    expect(tracker.pending).toBe(false);
    expect(tracker.settle()).toEqual([]);
    expect(tracker.move(2, p(0.8, 0.5))).toEqual([touch('move', p(0.25, 0.5), p(0.8, 0.5))]);
    expect(tracker.move(1, p(0.2, 0.5))).toEqual([touch('move', p(0.2, 0.5), p(0.8, 0.5))]);
    expect(tracker.down(3, p(0.5, 0.5))).toEqual([]);
    expect(tracker.up(1)).toEqual([touch('up', p(0.2, 0.5), p(0.8, 0.5))]);
    expect(tracker.move(2, p(0.7, 0.5))).toEqual([]);
    expect(tracker.up(2)).toEqual([]);
    expect(tracker.up(3)).toEqual([]);
    expect(tracker.down(4, p(0.5, 0.5))).toEqual([]);
    expect(tracker.pending).toBe(true);
  });

  it('sends a single finger once it settles, moves or lifts', () => {
    const tracker = gestures.createTouchTracker();
    tracker.down(1, p(0.5, 0.5));
    expect(tracker.settle()).toEqual([touch('down', p(0.5, 0.5))]);
    expect(tracker.move(1, p(0.5, 0.6))).toEqual([touch('move', p(0.5, 0.6))]);
    expect(tracker.up(1)).toEqual([touch('up', p(0.5, 0.6))]);

    tracker.down(2, p(0.1, 0.1));
    expect(tracker.move(2, p(0.2, 0.2))).toEqual([touch('down', p(0.1, 0.1)), touch('move', p(0.2, 0.2))]);
    tracker.up(2);

    tracker.down(3, p(0.3, 0.3));
    expect(tracker.up(3)).toEqual([touch('down', p(0.3, 0.3)), touch('up', p(0.3, 0.3))]);
  });

  it('lifts the settled finger and presses both when a second one lands later', () => {
    const tracker = gestures.createTouchTracker();
    tracker.down(1, p(0.25, 0.5));
    tracker.settle();
    expect(tracker.down(2, p(0.75, 0.5))).toEqual([
      touch('up', p(0.25, 0.5)),
      touch('down', p(0.25, 0.5), p(0.75, 0.5)),
    ]);
  });
});
