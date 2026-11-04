import type { TouchPhase } from '@/protocol/types';

export interface FingerPoint {
  x: number;
  y: number;
}

/** One `input.touch`: `second` is the second finger, which every phase of a two-finger gesture carries. */
export interface TouchMessage {
  phase: TouchPhase;
  first: FingerPoint;
  second?: FingerPoint;
}

type State = 'idle' | 'pending' | 'single' | 'double' | 'blocked';

const message = (phase: TouchPhase, first: FingerPoint, second?: FingerPoint): TouchMessage =>
  second ? { phase, first, second } : { phase, first };

/**
 * Turns real fingers, keyed by their touch id, into the `input.touch` messages of one gesture. The first finger waits
 * for `settle` so that a second finger landing just after it starts one two-finger gesture instead of a tap. Fingers
 * beyond the second are ignored, and once either finger of a two-finger gesture lifts, the gesture ends and the other
 * finger is ignored until every finger is up, because the finger count cannot change between a gesture's `down` and
 * `up`.
 */
export function createTouchTracker() {
  const fingers = new Map<number, FingerPoint>();
  let state: State = 'idle';
  const pair = (): { first: FingerPoint; second?: FingerPoint } | null => {
    const [first, second] = fingers.values();
    return first ? { first, ...(second ? { second } : {}) } : null;
  };
  const isPaired = (id: number) => [...fingers.keys()].indexOf(id) < 2;

  return {
    /** Whether the first finger is still waiting for a second one. */
    get pending() {
      return state === 'pending';
    },
    down(id: number, point: FingerPoint): TouchMessage[] {
      if (fingers.has(id)) return [];
      if (state === 'idle') {
        fingers.set(id, point);
        state = 'pending';
        return [];
      }
      if (state === 'blocked' || state === 'double' || fingers.size >= 2) {
        fingers.set(id, point);
        return [];
      }
      const held = pair();
      const lifted = state === 'single' && held ? [message('up', held.first)] : [];
      fingers.set(id, point);
      state = 'double';
      const both = pair();
      return both ? [...lifted, message('down', both.first, both.second)] : lifted;
    },
    /** Every finger that moved in one touch event, so that two moving fingers send one message. */
    move(updates: readonly (readonly [number, FingerPoint])[]): TouchMessage[] {
      const before = pair();
      let moved = false;
      for (const [id, point] of updates) {
        if (!fingers.has(id)) continue;
        fingers.set(id, point);
        moved ||= isPaired(id);
      }
      const now = pair();
      if (!moved || !now) return [];
      if (state === 'pending') {
        state = 'single';
        return before ? [message('down', before.first), message('move', now.first)] : [];
      }
      if (state === 'single') return [message('move', now.first)];
      return state === 'double' ? [message('move', now.first, now.second)] : [];
    },
    up(id: number): TouchMessage[] {
      const point = fingers.get(id);
      if (!point) return [];
      const both = pair();
      const ended = isPaired(id);
      fingers.delete(id);
      let messages: TouchMessage[] = [];
      if (state === 'pending') messages = [message('down', point), message('up', point)];
      else if (state === 'single') messages = [message('up', point)];
      else if (state === 'double' && ended && both) messages = [message('up', both.first, both.second)];
      if (state === 'double' && ended) state = 'blocked';
      else if (state === 'pending' || state === 'single') state = 'idle';
      if (fingers.size === 0) state = 'idle';
      return messages;
    },
    /** The first finger has stayed down alone for the settle time: it is a single touch. */
    settle(): TouchMessage[] {
      const held = pair();
      if (state !== 'pending' || !held) return [];
      state = 'single';
      return [message('down', held.first)];
    },
    /** The responder was taken away or the control session ended: lifts what is down and forgets every finger. */
    cancel(): TouchMessage[] {
      const both = pair();
      const messages =
        both && (state === 'single' || state === 'double') ? [message('up', both.first, both.second)] : [];
      fingers.clear();
      state = 'idle';
      return messages;
    },
  };
}
