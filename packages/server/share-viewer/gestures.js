'use strict';

/**
 * The two-finger input of the share viewer, as pure functions over points that are fractions of the screen. Each
 * function returns the `touch` messages the viewer sends; none touches the page.
 */
function touchMessage(phase, first, second) {
  return second
    ? { type: 'touch', phase, x: first.x, y: first.y, x2: second.x, y2: second.y }
    : { type: 'touch', phase, x: first.x, y: first.y };
}

/**
 * Where Option-drag puts the two fingers, as in Stim Desktop's TwoFingerPositions (adapted from Siniulator's
 * Multitouch.swift, MIT): the second finger mirrors the first through a center, and with Shift held both fingers
 * move together, which moves the center.
 */
class TwoFingerPositions {
  center = { x: 0.5, y: 0.5 };
  first = { x: 0.35, y: 0.5 };
  #previous = null;
  #translating = false;
  #offset = { x: 0, y: 0 };

  get second() {
    return { x: 2 * this.center.x - this.first.x, y: 2 * this.center.y - this.first.y };
  }

  resetTracking() {
    this.#previous = null;
    this.#translating = false;
    this.#offset = { x: 0, y: 0 };
  }

  update(pointer, translating) {
    const first = this.first;
    if (this.#previous && this.#translating !== translating) {
      this.#offset = { x: first.x - pointer.x, y: first.y - pointer.y };
    } else if (translating && this.#previous) {
      const other = this.second;
      const dx = Math.min(
        1 - Math.max(first.x, other.x),
        Math.max(-Math.min(first.x, other.x), pointer.x - this.#previous.x),
      );
      const dy = Math.min(
        1 - Math.max(first.y, other.y),
        Math.max(-Math.min(first.y, other.y), pointer.y - this.#previous.y),
      );
      this.center = { x: this.center.x + dx, y: this.center.y + dy };
      this.first = { x: first.x + dx, y: first.y + dy };
    } else {
      const { center } = this;
      this.first = {
        x: Math.min(Math.min(1, 2 * center.x), Math.max(Math.max(0, 2 * center.x - 1), pointer.x + this.#offset.x)),
        y: Math.min(Math.min(1, 2 * center.y), Math.max(Math.max(0, 2 * center.y - 1), pointer.y + this.#offset.y)),
      };
    }
    this.#previous = pointer;
    this.#translating = translating;
  }
}

/**
 * An Option-drag with a mouse or pen. `hover` and the `down`, `move` and `up` of a drag take the pointer and
 * whether Shift is held; each returns the messages to send. `pair` is the two fingers to draw while Option is
 * held, null otherwise. Releasing Option mid-drag lifts both fingers.
 */
function createMirroredGesture() {
  const positions = new TwoFingerPositions();
  let active = false;
  let showing = false;
  const fingers = () => [positions.first, positions.second];
  const lift = () => {
    active = false;
    return [touchMessage('up', ...fingers())];
  };
  return {
    get active() {
      return active;
    },
    get pair() {
      return showing ? fingers() : null;
    },
    hover(pointer, shift) {
      showing = true;
      positions.update(pointer, shift);
    },
    down(pointer, shift) {
      showing = true;
      positions.update(pointer, shift);
      active = true;
      return [touchMessage('down', ...fingers())];
    },
    move(pointer, shift, option) {
      if (!active) return [];
      if (!option) return lift();
      positions.update(pointer, shift);
      return [touchMessage('move', ...fingers())];
    },
    up(pointer, shift) {
      if (!active) return [];
      positions.update(pointer, shift);
      return lift();
    },
    /** Option was released or the pointer left: lifts the fingers of a drag and hides the pair. */
    release() {
      const messages = active ? lift() : [];
      showing = false;
      positions.resetTracking();
      return messages;
    },
  };
}

/**
 * Real touches. The first finger waits for `settle` so that a second finger landing just after it starts one
 * two-finger gesture instead of a tap. Fingers beyond the second are ignored, and once either finger of a
 * two-finger gesture lifts, the gesture ends and the other finger is ignored until every finger is up.
 */
function createTouchTracker() {
  const fingers = new Map();
  let state = 'idle';
  const pair = () => [...fingers.values()].slice(0, 2);
  return {
    get pending() {
      return state === 'pending';
    },
    down(id, point) {
      if (fingers.has(id)) return [];
      if (state === 'idle') {
        fingers.set(id, point);
        state = 'pending';
        return [];
      }
      if (state === 'blocked' || fingers.size >= 2) {
        fingers.set(id, point);
        return [];
      }
      const messages = state === 'single' ? [touchMessage('up', pair()[0])] : [];
      fingers.set(id, point);
      state = 'double';
      return [...messages, touchMessage('down', ...pair())];
    },
    move(id, point) {
      if (!fingers.has(id)) return [];
      const start = fingers.get(id);
      fingers.set(id, point);
      if (state === 'pending') {
        state = 'single';
        return [touchMessage('down', start), touchMessage('move', point)];
      }
      if (state === 'single') return [touchMessage('move', point)];
      return state === 'double' && pair().length === 2 && [...fingers.keys()].indexOf(id) < 2
        ? [touchMessage('move', ...pair())]
        : [];
    },
    up(id) {
      if (!fingers.has(id)) return [];
      const point = fingers.get(id);
      const both = pair();
      const ended = [...fingers.keys()].indexOf(id) < 2;
      fingers.delete(id);
      let messages = [];
      if (state === 'pending') messages = [touchMessage('down', point), touchMessage('up', point)];
      else if (state === 'single') messages = [touchMessage('up', point)];
      else if (state === 'double' && ended) messages = [touchMessage('up', ...both)];
      if (state === 'double' && ended) state = 'blocked';
      else if (state === 'pending' || state === 'single') state = 'idle';
      if (fingers.size === 0) state = 'idle';
      return messages;
    },
    /** The first finger has stayed down alone for the settle time: it is a single touch. */
    settle() {
      if (state !== 'pending') return [];
      state = 'single';
      return [touchMessage('down', pair()[0])];
    },
  };
}

globalThis.stimGestures = { TwoFingerPositions, createMirroredGesture, createTouchTracker };
